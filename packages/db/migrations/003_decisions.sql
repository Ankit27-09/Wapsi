-- 003_decisions.sql
--
-- The centre of the system: every evaluation the engine performs, whether or not it
-- acted, plus the outcome of the ones that did, plus the regulated messaging that some
-- of them sent.

-- ---------------------------------------------------------------------------
-- Decisions — including the decisions not to act
-- ---------------------------------------------------------------------------
-- This is deliberately not called `attempt`, and the naming carries a design argument.
--
-- A refusal is not an attempt. If refusals lived in an `attempt` table they would
-- consume `attempt_no`, and "attempt 2 of a maximum of 2" would silently start counting
-- the times the engine declined to act — which is exactly backwards, since declining is
-- what preserves the budget. But refusals must still be recorded with the same rigour as
-- actions, because "why didn't you try?" is the question this system exists to answer.
--
-- So: one row per evaluation. `verdict` says whether it fired. `attempt_no` and
-- `idempotency_key` are populated only when it did. The expected-value arithmetic is
-- snapshotted on every row, so a refusal can explain itself in rupees months later,
-- against the policy version that was in force at the time.

create table decision (
  id              uuid        primary key default gen_random_uuid(),
  txn_id          uuid        not null references txn(id) on delete cascade,
  batch_id        uuid        not null references batch(id) on delete cascade,
  trace_id        text        not null,
  policy_version  integer     not null,
  reason_code     text        not null references reason_code(code),

  evaluated_at    timestamptz not null default now(),

  verdict         text        not null check (verdict in (
                                'fire',
                                'refuse_ev',            -- expected value below the floor
                                'refuse_bounds',        -- a cap, ceiling, window or consent rule
                                'refuse_terminal',      -- retrying is structurally pointless
                                'refuse_kill_switch'    -- global halt
                              )),
  refuse_detail   text,

  planned_action  text        not null check (planned_action in (
                                'retry', 'switch_rail', 'notify', 'escalate', 'none'
                              )),
  planned_rail    text        check (planned_rail in ('card','upi_collect','upi_intent','netbanking','wallet')),

  -- ---- the expected-value snapshot, as integers ----------------------------
  -- Recorded even for refusals. This is what makes a refusal auditable rather than
  -- merely logged: the arithmetic that produced it is on the row.
  ev_p_bps        integer     not null check (ev_p_bps between 0 and 10000),
  ev_value_paise  bigint      not null check (ev_value_paise >= 0),
  ev_cost_paise   bigint      not null check (ev_cost_paise >= 0),
  ev_net_paise    bigint      not null,   -- signed: a negative EV is the point of the gate

  -- ---- populated only when verdict = 'fire' --------------------------------
  attempt_no      integer     check (attempt_no >= 1),

  -- sha256(txn_id | attempt_no | policy_version). Derived rather than random, so a
  -- worker that crashes and restarts recomputes the identical key and the unique index
  -- below refuses the duplicate. Invariant I2.
  idempotency_key text,

  state           text        not null default 'planned' check (state in (
                                'planned',    -- gate passed, not yet dispatched
                                'pending',    -- dispatched to the gateway, result unknown
                                'settled',    -- outcome recorded
                                'abandoned'   -- reconciliation found no gateway record
                              )),
  updated_at      timestamptz not null default now(),

  -- A fired decision must carry the identity that makes it replay-safe; a refusal must
  -- not pretend to. Both halves are enforced, so neither can be forgotten.
  constraint decision_fire_is_identified check (
    (verdict = 'fire') = (attempt_no is not null and idempotency_key is not null)
  ),
  constraint decision_refusal_is_inert check (
    verdict = 'fire' or state = 'planned'
  )
);

-- Invariant I2, as an index. Partial, because refusals legitimately have no key and
-- Postgres would otherwise treat every NULL as distinct anyway — stating it explicitly
-- documents the intent.
create unique index decision_idempotency_key_uq
  on decision (idempotency_key) where idempotency_key is not null;

-- Attempt numbering is per transaction and gapless among fired decisions.
create unique index decision_attempt_no_uq
  on decision (txn_id, attempt_no) where attempt_no is not null;

create index decision_batch_verdict_idx on decision (batch_id, verdict);
create index decision_trace_idx         on decision (trace_id);

-- The worker's claim query targets this: rows dispatched but unresolved, oldest first.
create index decision_pending_idx
  on decision (state, updated_at) where state = 'pending';

-- ---------------------------------------------------------------------------
-- Outcomes
-- ---------------------------------------------------------------------------

create table outcome (
  decision_id      uuid        primary key references decision(id) on delete cascade,
  success          boolean     not null,
  gateway_code     text,
  fee_paise        bigint      not null default 0 check (fee_paise >= 0),
  recovered_paise  bigint      not null default 0 check (recovered_paise >= 0),
  settled_at       timestamptz not null default now(),

  -- A failed attempt cannot have recovered money. Cheap to state, and it is the
  -- constraint that would catch a simulator bug before it reached a headline number.
  constraint outcome_recovery_requires_success check (success or recovered_paise = 0)
);

-- ---------------------------------------------------------------------------
-- Regulated messaging
-- ---------------------------------------------------------------------------
-- In India, commercial SMS requires a DLT-registered template and WhatsApp business
-- messaging requires a pre-approved template plus opt-in. A recovery agent that
-- free-generates message text is not shippable however good the copy is.
--
-- The schema makes that structural rather than procedural: `message_send.template_id`
-- is NOT NULL and references a registered template. There is no column in which
-- free-form model output could be sent. The model's role is to fill `variables` inside
-- an approved body, and to draft NEW templates into this table with
-- status = 'draft_pending_review' for a human to register.

create table message_template (
  id              text        primary key,
  dlt_template_id text,
  channel         text        not null check (channel in ('sms', 'whatsapp', 'email')),
  language        text        not null check (language in ('en', 'hi_latn')),
  body            text        not null,
  variables       text[]      not null default '{}',
  status          text        not null default 'draft_pending_review'
                              check (status in ('registered', 'draft_pending_review', 'retired')),
  created_at      timestamptz not null default now(),

  -- A registered template must carry the registration id that makes it legal to send.
  -- Without this constraint, "registered" is a label; with it, it is a fact.
  constraint template_registered_has_dlt_id check (
    status <> 'registered' or dlt_template_id is not null
  )
);

create table message_send (
  id             bigserial   primary key,
  decision_id    uuid        not null references decision(id) on delete cascade,
  customer_id    uuid        not null references customer(id),
  template_id    text        not null references message_template(id),
  channel        text        not null check (channel in ('sms', 'whatsapp', 'email')),

  -- The rendered body is stored for the inbox view and for evidence. It is derived from
  -- template + variables, so it can always be re-verified against the approved body —
  -- a send whose rendered text does not match its template is detectable after the fact.
  rendered_body  text        not null,
  variables      jsonb       not null default '{}'::jsonb,
  cost_paise     bigint      not null default 0 check (cost_paise >= 0),
  sent_at        timestamptz not null default now()
);

-- Supports the weekly contact-ceiling check, which is derived by counting this table
-- rather than by maintaining a counter.
create index message_send_customer_window_idx on message_send (customer_id, sent_at desc);
create index message_send_decision_idx        on message_send (decision_id);
