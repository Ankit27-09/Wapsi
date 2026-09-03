import { REASON_CODES, REASON_CODE_META } from '@rc/core';
import type { DbOrTx } from './client.js';

/**
 * Reference data: the rows other tables hold foreign keys to.
 *
 * WHY THIS MOVED HERE. The taxonomy is a table rather than a Postgres enum, so that the
 * open-world path can propose new reason codes at runtime without a migration — see
 * `002_transactions.sql`. Something therefore has to seed the known ones, and that seeder
 * lived inside the evaluation harness, which made "the taxonomy exists" a side effect of
 * running an experiment.
 *
 * That held only as long as the harness was the sole entry point. It stopped holding when
 * `degradation_signal.dominant_code` acquired a foreign key to `reason_code`: detection runs
 * over the authorisation stream, which the simulator writes, and generating a batch and then
 * detecting on it — without an eval arm anywhere in the picture — failed on the constraint.
 * The database was right and the layering was wrong. Reference data belongs to the package
 * that owns the schema.
 *
 * Idempotent, so every entry point can call it without coordinating with the others.
 */
export async function ensureReasonCodesSeeded(db: DbOrTx): Promise<void> {
  await db
    .insertInto('reason_code')
    .values(
      REASON_CODES.map((code) => ({
        code,
        terminal: REASON_CODE_META[code].terminal,
        notifiable: REASON_CODE_META[code].notifiable,
        never_contact: REASON_CODE_META[code].neverContact,
        note: REASON_CODE_META[code].note,
      })),
    )
    // `doNothing` rather than an upsert. A code whose metadata has been changed by an
    // approved open-world proposal must not be silently reverted to its seeded definition by
    // the next process that happens to start up.
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();
}
