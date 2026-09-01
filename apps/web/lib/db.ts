import { createDb, type Db } from '@rc/db';

/**
 * One connection for the whole server process.
 *
 * Every other entry point in this repository owns its handle and closes it, because they
 * are short-lived commands. A web server is the opposite: it lives for the session and
 * serves many requests, and opening a pool per request would exhaust Postgres in seconds.
 *
 * Cached on `globalThis` rather than in a module variable because Next's dev server reloads
 * modules on every edit — a plain module-level singleton would leak a pool per hot reload,
 * and the symptom (connection exhaustion after twenty file saves) looks nothing like its
 * cause.
 */
const globalForDb = globalThis as unknown as { rcDb?: Db };

export function db(): Db {
  globalForDb.rcDb ??= createDb().db;
  return globalForDb.rcDb;
}
