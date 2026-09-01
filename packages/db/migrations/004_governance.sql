-- 004_governance.sql
--
-- The audit trail, the versioned policy that governs every decision, the proposal queue
-- through which the agent may suggest changes to it, and the model-cost ledger.

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
-- Append-only, enforced by trigger in 005. Every action AND every refusal writes a row.
--
-- `actor` is the load-bearing column. It distinguishes the deterministic policy engine
-- from the model from the human, which is what allows the question "did an LLM decide
-- this?" to be answered by a query rather than by reading code. In this system the
-- answer is always no for anything involving money, and the audit trail is how that is
-- demonstrated rather than asserted.

create table audit (
  id             bigserial   primary key,
  trace_id       text        not null,
  batch_id       uuid        references batch(id) on delete cascade,
  txn_id         uuid        references txn(id) on delete cascade,
  decision_id    uuid        references decision(id) on delete cascade,

  event_type     text        not null,

  actor          text        not null check (
                               actor = 'policy_engine'
                               or actor = 'worker'
                               or actor = 'simulator'
                               or actor like 'llm:%'
                               or actor like 'human:%'
                             ),

  policy_version integer,
  payload        jsonb       not null default '{}'::jsonb,

  -- Human-readable justification. For deterministic events this is generated from the
  -- rule that fired; for classifications it is the model's stated rationale. It is
  -- narration attached to a decision, never the basis for one.
  rationale      text,

  occurred_at    timestamptz not null default now()
);

create index audit_trace_idx    on audit (trace_id, id);
create index audit_txn_idx      on audit (txn_id, id);
create index audit_batch_idx    on audit (batch_id, id);
create index audit_type_idx     on audit (event_type, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Policy versions
-- ---------------------------------------------------------------------------
-- The full YAML is snapshotted, not diffed, so reconstructing the exact rules that
-- governed a decision from nine versions ago is a single lookup rather than a replay.
-- Storage is free at this scale; ambiguity about what the rules were is not.

create table policy_version (
  version        integer     primary key,
  parent_version integer     references policy_version(version),
  yaml           text        not null,

  -- sha256 of the YAML. Stamped onto proposals so an approval cannot be replayed
  -- against different content than the approver read.
  hash           text        not null,

  approved_by    text        not null,
  approved_at    timestamptz not null default now(),

  constraint policy_version_positive check (version >= 1),
  constraint policy_version_not_own_parent check (parent_version is null or parent_version < version)
);

-- ---------------------------------------------------------------------------
-- Policy proposals — the bounded self-improvement loop
-- ---------------------------------------------------------------------------
-- The agent reads a completed batch's audit trail and proposes a change to the tuning
-- parameters. It cannot apply one. The safety bounds — kill switch, quiet hours, contact
-- ceilings, consent rules, fee budget — are absent from the proposal schema in
-- @rc/ai, so a malformed or adversarial proposal cannot reach them; and the range clamps
-- are re-checked here on the way in, because a guarantee that exists in only one layer
-- is a guarantee that survives exactly one refactor.

create table policy_proposal (
  id                        bigserial   primary key,
  from_version              integer     not null references policy_version(version),
  batch_id                  uuid        references batch(id) on delete set null,

  -- The diff, as a flat map of dotted paths to new values. Flat rather than nested so
  -- that "which fields does this touch?" is a key scan and can be validated against the
  -- whitelist without walking a tree.
  diff                      jsonb       not null,

  rationale                 text        not null,
  evidence_decision_ids     uuid[]      not null default '{}',
  predicted_net_delta_paise bigint      not null,
  confidence_bps            integer     not null check (confidence_bps between 0 and 10000),

  status                    text        not null default 'awaiting'
                                        check (status in ('awaiting', 'approved', 'rejected')),
  decided_by                text,
  decided_at                timestamptz,
  decision_note             text,

  -- The version this proposal produced, once approved. Null while awaiting or rejected.
  applied_version           integer     references policy_version(version),

  created_at                timestamptz not null default now(),

  -- A decision requires an author and a timestamp; an undecided proposal must have
  -- neither. This is what makes "approved by whom, and when?" unanswerable-by-omission
  -- impossible.
  constraint proposal_decision_complete check (
    (status = 'awaiting') = (decided_by is null and decided_at is null)
  ),
  constraint proposal_applied_only_when_approved check (
    applied_version is null or status = 'approved'
  ),

  -- A proposal must claim a reason to exist. An empty diff is a bug in the proposer,
  -- not a no-op worth storing.
  constraint proposal_diff_not_empty check (jsonb_typeof(diff) = 'object' and diff <> '{}'::jsonb)
);

create index policy_proposal_status_idx on policy_proposal (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Model call ledger
-- ---------------------------------------------------------------------------
-- Replaces a self-hosted observability service. The cost model needs these figures in
-- the database to compute rupees-spent-per-rupee-recovered, so putting them anywhere
-- else would mean importing them back.

create table llm_call (
  id            bigserial   primary key,
  trace_id      text        not null,
  batch_id      uuid        references batch(id) on delete cascade,
  purpose       text        not null check (purpose in ('classify', 'cluster', 'propose', 'render', 'summarise')),
  model         text        not null,
  input_tokens  integer     not null default 0 check (input_tokens >= 0),
  output_tokens integer     not null default 0 check (output_tokens >= 0),
  cached_tokens integer     not null default 0 check (cached_tokens >= 0),
  cost_paise    bigint      not null default 0 check (cost_paise >= 0),
  latency_ms    integer     not null default 0 check (latency_ms >= 0),
  ok            boolean     not null,
  error         text,
  created_at    timestamptz not null default now(),

  -- A failed call has an error; a successful one does not. Keeps "how often does the
  -- model fail, and why" answerable without parsing free text.
  constraint llm_call_error_iff_failed check (ok = (error is null))
);

create index llm_call_batch_purpose_idx on llm_call (batch_id, purpose);
create index llm_call_trace_idx         on llm_call (trace_id);
