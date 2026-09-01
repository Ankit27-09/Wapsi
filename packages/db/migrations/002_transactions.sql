-- 002_transactions.sql
--
-- The failed payment, the raw gateway payload that described it, the taxonomy as data,
-- and the classification that mapped one onto the other.

-- ---------------------------------------------------------------------------
-- The taxonomy, as a table rather than an enum
-- ---------------------------------------------------------------------------
-- A Postgres enum would be the obvious choice, and it is the wrong one: the open-world
-- path proposes NEW reason codes at runtime, from clustered strings the classifier could
-- not place. A proposal that requires a migration is a proposal that never ships, so the
-- taxonomy is rows, and `added_by` records whether a class was seeded by a human or
-- proposed by the agent and approved.

create table reason_code (
  code         text        primary key,
  terminal     boolean     not null,
  notifiable   boolean     not null,
  never_contact boolean    not null default false,
  note         text        not null,
  added_by     text        not null default 'seed' check (added_by in ('seed', 'proposal')),
  added_in_policy_version integer,
  created_at   timestamptz not null default now(),

  -- A terminal code can still be notifiable (an expired card needs a nudge), but a code
  -- that must never be contacted cannot simultaneously be notifiable. Encoding the
  -- contradiction as a constraint means a bad open-world proposal is rejected by the
  -- database rather than by a reviewer's attention.
  constraint reason_code_contact_coherent check (not (never_contact and notifiable))
);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

create table txn (
  id            uuid        primary key default gen_random_uuid(),
  batch_id      uuid        not null references batch(id) on delete cascade,
  customer_id   uuid        not null references customer(id),

  -- Money is BIGINT paise. Never numeric, never double precision. The check makes a
  -- zero or negative "failed payment" impossible to record.
  amount_paise  bigint      not null check (amount_paise > 0),

  -- Contribution margin in integer basis points. The expected-value gate multiplies by
  -- this rather than by the gross amount, because recovering a rupee of revenue is not
  -- worth a rupee of effort — it is worth its margin. Storing it per transaction lets
  -- the batch contain a realistic mix rather than one blended assumption.
  margin_bps    integer     not null check (margin_bps between 0 and 10000),

  rail          text        not null check (rail in ('card','upi_collect','upi_intent','netbanking','wallet')),
  is_recurring  boolean     not null default false,
  mandate_ref   text,
  failed_at     timestamptz not null,
  created_at    timestamptz not null default now(),

  -- A recurring failure without a mandate reference is not representable: the two facts
  -- travel together or the mandate-expiry path has nothing to escalate.
  constraint txn_recurring_has_mandate check (not is_recurring or mandate_ref is not null)
);

create index txn_batch_idx    on txn (batch_id);
create index txn_customer_idx on txn (customer_id, failed_at desc);

-- ---------------------------------------------------------------------------
-- The raw gateway payload, preserved verbatim
-- ---------------------------------------------------------------------------
-- `gateway_description` is untrusted free text. It is preserved exactly as received
-- for two reasons: it is the input to the classifier ablation, and it is the injection
-- surface. Storing a cleaned version instead would destroy the evidence needed to prove
-- the LLM earns its place, and would hide the attack it has to withstand.

create table failure_event (
  id                   bigserial   primary key,
  txn_id               uuid        not null unique references txn(id) on delete cascade,
  gateway_code         text,
  gateway_description  text        not null,
  raw                  jsonb       not null default '{}'::jsonb,
  received_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Classification
-- ---------------------------------------------------------------------------

create table classification (
  id             bigserial   primary key,
  txn_id         uuid        not null references txn(id) on delete cascade,
  reason_code    text        not null references reason_code(code),

  -- Confidence in integer basis points, matching the money path's convention. The model
  -- returns a float; it is converted at the Zod boundary and never stored as one.
  confidence_bps integer     not null check (confidence_bps between 0 and 10000),

  -- Which arm of the ablation produced this. The whole point of recording it is to be
  -- able to answer "what would this batch have earned without the LLM?" from data
  -- rather than from a second run.
  method         text        not null check (method in ('keyword', 'llm', 'llm_open_world')),
  model          text,
  prompt_hash    text,

  -- Below the calibrated threshold the transaction is quarantined instead of acted on.
  -- No intervention fires on an unclassified root cause.
  quarantined    boolean     not null default false,

  input_tokens   integer,
  output_tokens  integer,
  cost_paise     bigint      not null default 0 check (cost_paise >= 0),
  latency_ms     integer,
  created_at     timestamptz not null default now(),

  -- One classification per transaction per method, so the ablation arms coexist in one
  -- table and can be compared with a join rather than a second database.
  unique (txn_id, method)
);

create index classification_reason_idx on classification (reason_code, method);
create index classification_quarantine_idx on classification (quarantined) where quarantined;
