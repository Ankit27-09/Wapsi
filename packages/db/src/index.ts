/**
 * @rc/db — schema, migrations, and the typed client.
 *
 * This package owns the append-only guarantees. Nothing outside it constructs SQL, and
 * nothing outside it sees a raw row: boundary strings from `pg` are converted into branded
 * `Paise` here, so a caller cannot accidentally treat an amount as a number.
 *
 * The surface below is deliberately small — only what other packages actually consume. An
 * earlier version re-exported every row helper and enum in the schema on the theory that
 * someone might want them; nothing did, and a public API nobody called still had to be read
 * and kept correct. Types used only inside this package stay inside it.
 */

export type {
  Arm,
  Channel,
  ClassifyMethod,
  ConsentState,
  Database,
  PlannedAction,
  PromiseSource,
  PromiseStatus,
  Rail,
  RiskClass,
  Timing,
  Verdict,
} from './schema.js';

export {
  type BatchBudget,
  type Db,
  type DbEnv,
  type DbHandle,
  type DbOrTx,
  createDb,
  isDatabaseReachable,
  lockBatchBudget,
  withTx,
} from './client.js';
