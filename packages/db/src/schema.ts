import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * The database, as types.
 *
 * Hand-written rather than generated. Two reasons, and both are deliberate: the schema
 * is small enough that generation buys little, and hand-writing forces the money
 * columns to be typed as `string` at the boundary — which is exactly what `pg` returns
 * for `BIGINT` and exactly the thing a generator would smooth over into `number`,
 * silently reintroducing floating point into the money path.
 *
 * Conversion from these boundary strings into branded `Paise` happens in the repository
 * functions, through `PaiseSchema`. Nothing outside this package sees a raw row.
 */

/**
 * `BIGINT` as `pg` hands it over: a decimal string, never a JS number.
 *
 * Plainly `string` rather than a three-way `ColumnType`. An earlier version allowed
 * `string | bigint` on write, which bought flexibility no caller used — every write site
 * stringifies a `Paise` — and cost real type errors, because `Generated<ColumnType<…>>`
 * does not unwrap cleanly through Kysely's update and comparison positions.
 *
 * What matters is preserved: the SELECT type is `string`, so an int64 never passes through
 * a JS number on its way out of the database.
 */
type Bigint = string;

/** `timestamptz`. Read as `Date`, written as `Date` — every call site already passes one. */
type Timestamp = Date;

/** A column the database fills in and nobody updates. */
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;

export interface Database {
  /**
   * The migrator's own ledger. Declared here rather than cast at the call site: it is a
   * real table, and a schema type that omits it forces `as never` into the one file that
   * should be the most auditable in the package.
   */
  _migration: MigrationTable;

  customer: CustomerTable;
  consent_event: ConsentEventTable;
  consent_current: ConsentCurrentView;
  batch: BatchTable;
  batch_budget: BatchBudgetTable;
  reason_code: ReasonCodeTable;
  txn: TxnTable;
  failure_event: FailureEventTable;
  classification: ClassificationTable;
  decision: DecisionTable;
  outcome: OutcomeTable;
  message_template: MessageTemplateTable;
  message_send: MessageSendTable;
  audit: AuditTable;
  policy_version: PolicyVersionTable;
  policy_proposal: PolicyProposalTable;
  llm_call: LlmCallTable;

  /**
   * Simulator scaffolding, not product. See `006_simulator_gateway.sql`.
   *
   * Declared here because the simulator uses the same typed client; the engine never
   * touches it, reaching the gateway only through the `Gateway` interface.
   */
  sim_gateway_log: SimGatewayLogTable;
}

// ---------------------------------------------------------------------------
// Enumerated column values, mirrored from the CHECK constraints
// ---------------------------------------------------------------------------
// Kept as unions rather than Postgres enums so the open-world path can add reason codes
// without a migration. The CHECK constraints remain the authority; these are the
// compile-time echo of them.

export type Channel = 'sms' | 'whatsapp' | 'email';
export type ConsentState = 'opt_in' | 'opt_out';
export type Rail = 'card' | 'upi_collect' | 'upi_intent' | 'netbanking' | 'wallet';
export type Arm = 'rc' | 'b0' | 'b1' | 'b2' | 'b3_oracle';
/**
 * Ablation arms. `oracle` reads the simulator's seeded cause — a measurement ceiling that
 * isolates the cost of imperfect classification, never a deployable strategy.
 */
export type ClassifyMethod = 'keyword' | 'llm' | 'llm_open_world' | 'oracle';

export type Verdict =
  | 'fire'
  | 'refuse_ev'
  | 'refuse_bounds'
  | 'refuse_terminal'
  | 'refuse_kill_switch';

export type PlannedAction = 'retry' | 'switch_rail' | 'notify' | 'escalate' | 'none';

/**
 * Timing buckets, mirrored from `priors.published.yaml`.
 *
 * Duplicated rather than imported from @rc/policy: this package is depended on by both
 * sides of the Chinese wall, so it must not pull the policy in. The `decision_timing`
 * CHECK constraint remains the authority; this is its compile-time echo.
 */
export type Timing =
  | 'immediate'
  | 'short_backoff'
  | 'medium_backoff'
  | 'next_day'
  | 'salary_window'
  | 'alt_rail';
export type DecisionState = 'planned' | 'pending' | 'settled' | 'abandoned';
export type TemplateStatus = 'registered' | 'draft_pending_review' | 'retired';
export type ProposalStatus = 'awaiting' | 'approved' | 'rejected';
export type LlmPurpose = 'classify' | 'cluster' | 'propose' | 'render' | 'summarise';

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface MigrationTable {
  name: string;
  checksum: string;
  applied_at: CreatedAt;
}

export interface CustomerTable {
  id: Generated<string>;
  external_ref: string;
  display_name: string;
  /** Which registered template variant this customer receives. `hi_latn` is Hinglish. */
  preferred_language: Generated<'en' | 'hi_latn'>;
  created_at: CreatedAt;
}

export interface ConsentEventTable {
  id: Generated<number>;
  customer_id: string;
  channel: Channel;
  state: ConsentState;
  source: string;
  recorded_at: CreatedAt;
}

/** Derived view — latest consent per (customer, channel). Never written to. */
export interface ConsentCurrentView {
  customer_id: string;
  channel: Channel;
  state: ConsentState;
  recorded_at: Timestamp;
}

export interface BatchTable {
  id: Generated<string>;
  seed: number;
  arm: Arm;
  world: Generated<string>;
  policy_version: number | null;
  record_count: Generated<number>;
  started_at: CreatedAt;
  finished_at: Timestamp | null;
}

export interface BatchBudgetTable {
  batch_id: string;
  fee_budget_paise: Bigint;
  fee_spent_paise: Generated<Bigint>;
}

export interface ReasonCodeTable {
  code: string;
  terminal: boolean;
  notifiable: boolean;
  never_contact: Generated<boolean>;
  note: string;
  added_by: Generated<'seed' | 'proposal'>;
  added_in_policy_version: number | null;
  created_at: CreatedAt;
}

export interface TxnTable {
  id: Generated<string>;
  batch_id: string;
  customer_id: string;
  /**
   * Position in the seeded population, identical across worlds.
   *
   * Outcome draws key on this rather than on `id`, so every arm faces the same coin flips.
   * See `011_logical_ref.sql`.
   */
  logical_ref: string;
  amount_paise: Bigint;
  margin_bps: number;
  rail: Rail;
  is_recurring: Generated<boolean>;
  mandate_ref: string | null;
  failed_at: Timestamp;
  created_at: CreatedAt;
}

export interface FailureEventTable {
  id: Generated<number>;
  txn_id: string;
  gateway_code: string | null;
  /** Untrusted free text. The classifier's input and the injection surface. */
  gateway_description: string;
  raw: Generated<unknown>;
  received_at: CreatedAt;
}

export interface ClassificationTable {
  id: Generated<number>;
  txn_id: string;
  reason_code: string;
  confidence_bps: number;
  method: ClassifyMethod;
  model: string | null;
  prompt_hash: string | null;
  quarantined: Generated<boolean>;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_paise: Generated<Bigint>;
  latency_ms: number | null;
  created_at: CreatedAt;
}

export interface DecisionTable {
  id: Generated<string>;
  txn_id: string;
  batch_id: string;
  trace_id: string;
  policy_version: number;
  reason_code: string;
  evaluated_at: CreatedAt;
  verdict: Verdict;
  refuse_detail: string | null;
  planned_action: PlannedAction;
  planned_rail: Rail | null;
  /** Required for a fired decision, null for a refusal. Enforced by CHECK. */
  planned_timing: Timing | null;

  ev_p_bps: number;
  ev_value_paise: Bigint;
  ev_cost_paise: Bigint;
  /** Signed. A negative expected value is the whole point of the gate. */
  ev_net_paise: Bigint;

  attempt_no: number | null;
  idempotency_key: string | null;
  state: Generated<DecisionState>;
  updated_at: Generated<Timestamp>;
}

export interface OutcomeTable {
  decision_id: string;
  success: boolean;
  gateway_code: string | null;
  fee_paise: Generated<Bigint>;
  recovered_paise: Generated<Bigint>;
  settled_at: CreatedAt;
}

export interface MessageTemplateTable {
  id: string;
  /** Groups language variants of one message. The resolver picks a variant within a family. */
  family: string;
  dlt_template_id: string | null;
  channel: Channel;
  language: 'en' | 'hi_latn';
  body: string;
  variables: Generated<string[]>;
  status: Generated<TemplateStatus>;
  created_at: CreatedAt;
}

export interface MessageSendTable {
  id: Generated<number>;
  decision_id: string;
  customer_id: string;
  template_id: string;
  channel: Channel;
  rendered_body: string;
  variables: Generated<unknown>;
  cost_paise: Generated<Bigint>;
  sent_at: CreatedAt;
}

export interface AuditTable {
  id: Generated<number>;
  trace_id: string;
  batch_id: string | null;
  txn_id: string | null;
  decision_id: string | null;
  event_type: string;
  /** `policy_engine` | `worker` | `simulator` | `llm:<model>` | `human:<id>` */
  actor: string;
  policy_version: number | null;
  payload: Generated<unknown>;
  rationale: string | null;
  occurred_at: CreatedAt;
}

export interface PolicyVersionTable {
  version: number;
  parent_version: number | null;
  yaml: string;
  hash: string;
  approved_by: string;
  approved_at: CreatedAt;
}

export interface PolicyProposalTable {
  id: Generated<number>;
  from_version: number;
  batch_id: string | null;
  diff: unknown;
  rationale: string;
  evidence_decision_ids: Generated<string[]>;
  predicted_net_delta_paise: Bigint;
  confidence_bps: number;
  status: Generated<ProposalStatus>;
  decided_by: string | null;
  decided_at: Timestamp | null;
  decision_note: string | null;
  applied_version: number | null;
  created_at: CreatedAt;
}

export interface LlmCallTable {
  id: Generated<number>;
  trace_id: string;
  batch_id: string | null;
  purpose: LlmPurpose;
  model: string;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  cached_tokens: Generated<number>;
  cost_paise: Generated<Bigint>;
  latency_ms: Generated<number>;
  ok: boolean;
  error: string | null;
  created_at: CreatedAt;
}

export interface SimGatewayLogTable {
  idempotency_key: string;
  succeeded: boolean;
  gateway_code: string | null;
  fee_paise: Bigint;
  recovered_paise: Bigint;
  batch_id: string | null;
  received_at: CreatedAt;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

export type DecisionRow = Selectable<DecisionTable>;
export type NewDecision = Insertable<DecisionTable>;
export type DecisionUpdate = Updateable<DecisionTable>;

export type TxnRow = Selectable<TxnTable>;
export type NewTxn = Insertable<TxnTable>;

export type AuditRow = Selectable<AuditTable>;
export type NewAudit = Insertable<AuditTable>;

export type OutcomeRow = Selectable<OutcomeTable>;
export type NewOutcome = Insertable<OutcomeTable>;
