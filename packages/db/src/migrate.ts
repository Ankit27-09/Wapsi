import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { createDb, loadDbEnv, type Db } from './client.js';

/**
 * A forward-only SQL migrator, in about a hundred lines.
 *
 * Deliberately not an ORM migration tool. The interesting parts of this schema are
 * triggers, CHECK constraints and partial unique indexes — the things a migration
 * generator either cannot express or expresses badly. Those are the product here, not
 * an implementation detail, so they are written as reviewable SQL and applied in order.
 *
 * Rules:
 *   - Files are applied once, in filename order, each in its own transaction.
 *   - An applied file is never edited. Its checksum is recorded, and a changed checksum
 *     is a hard failure rather than a silent divergence between environments.
 *   - There is no `down`. Rolling back a schema change on a system that has recorded
 *     money is a data-loss operation dressed as a convenience; the recovery path is a
 *     new forward migration, or `reset` in local development.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface Migration {
  readonly name: string;
  readonly sqlText: string;
  readonly checksum: string;
}

async function ensureLedger(db: Db): Promise<void> {
  await sql`
    create table if not exists _migration (
      name        text        primary key,
      checksum    text        not null,
      applied_at  timestamptz not null default now()
    )
  `.execute(db);
}

async function loadMigrations(): Promise<readonly Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const sqlText = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      return {
        name,
        sqlText,
        checksum: createHash('sha256').update(sqlText).digest('hex').slice(0, 16),
      };
    }),
  );
}

async function up(db: Db): Promise<void> {
  await ensureLedger(db);

  const rows = await db.selectFrom('_migration').select(['name', 'checksum']).execute();
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));

  const migrations = await loadMigrations();
  let count = 0;

  for (const migration of migrations) {
    const previous = applied.get(migration.name);

    if (previous !== undefined) {
      // A changed checksum means someone edited history. Two machines running this
      // repository would silently have different schemas, and the reproducibility claim
      // in the README would be false. Refuse loudly.
      if (previous !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} has changed since it was applied ` +
            `(${previous} → ${migration.checksum}).\n` +
            `Applied migrations are immutable. Add a new migration file instead, ` +
            `or run "pnpm db:reset" in local development.`,
        );
      }
      continue;
    }

    // Each file is one transaction: it applies completely or not at all. Postgres
    // supports transactional DDL, which is why the triggers and constraints in this
    // schema can be trusted to exist together or not at all.
    await db.transaction().execute(async (tx) => {
      await sql.raw(migration.sqlText).execute(tx);
      await sql`
        insert into _migration (name, checksum)
        values (${migration.name}, ${migration.checksum})
      `.execute(tx);
    });

    process.stdout.write(`  applied  ${migration.name}\n`);
    count += 1;
  }

  process.stdout.write(
    count === 0
      ? `  up to date (${migrations.length} migrations)\n`
      : `  ${count} migration(s) applied\n`,
  );
}

/**
 * Drop and rebuild. Local development only.
 *
 * Guarded on the connection string: this must never be reachable against anything that
 * is not obviously a local database. The guard is crude on purpose — a clever guard is
 * one someone eventually argues their way around.
 */
async function reset(db: Db, url: string): Promise<void> {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== 'postgres') {
    throw new Error(`Refusing to reset a non-local database (host: ${host})`);
  }

  await sql`drop schema public cascade`.execute(db);
  await sql`create schema public`.execute(db);
  process.stdout.write('  schema dropped\n');
  await up(db);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const env = loadDbEnv();
  const { db, close } = createDb(env);

  try {
    switch (command) {
      case 'up':
        await up(db);
        break;
      case 'reset':
        await reset(db, env.DATABASE_URL);
        break;
      default:
        throw new Error(`Unknown command "${command}". Expected "up" or "reset".`);
    }
  } finally {
    await close();
  }
}

await main();
