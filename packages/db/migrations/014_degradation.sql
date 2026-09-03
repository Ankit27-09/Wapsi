-- 014_degradation.sql
--
-- DETECTION. The brief's first verb, and until now the one this system did not do.
--
-- Everything before this migration starts from a queue of transactions that had ALREADY
-- failed and already been triaged into a recovery case. That satisfies "determines the right
-- intervention" and "executes a bounded recovery workflow"; it does not satisfy "detects
-- revenue at risk", and it does not address the brief's first example direction, which is
-- specifically "payment DEGRADATION → root cause → recovery action".
--
-- Degradation is a property of a population over time, not of a transaction. "This card was
-- declined" is an event. "Authorisation success on ISS_COOP cards fell from 91% to 34% over
-- the last forty minutes" is a degradation, and no amount of looking at one declined card
-- reveals it. Detecting it needs the thing this schema was missing: A DENOMINATOR.
--
-- So this migration adds the merchant's authorisation stream — every attempt, succeeded and
-- failed alike. In a real deployment it is fed by gateway webhooks; here the simulator
-- produces it. Failures in that stream are where recovery cases come from, which makes the
-- pipeline honest end to end: the agent observes live traffic, notices a cohort going bad,
-- and only then starts deciding what to do about individual transactions inside it.

-- ---------------------------------------------------------------------------
-- The issuer, promoted to a column
-- ---------------------------------------------------------------------------
-- It was already in the data, concatenated into `customer.external_ref` as the fifth
-- colon-separated field, because nothing needed to GROUP BY it. A detector does nothing but
-- group by it, and parsing an identifier out of a display string to do arithmetic on it is
-- how a demo becomes unmaintainable. Backfilled from the reference below rather than
-- regenerated, so existing batches keep their populations and stay comparable.

alter table txn add column issuer_id text;

-- The BIN bucket, which is a coarser cohort than the issuer and a finer one than the rail.
-- Real degradations are frequently narrower than an issuer: one BIN range on one network
-- behind one acquirer. Nullable because only card traffic has one — a UPI collect request
-- has no BIN, and inventing a placeholder would create a cohort that cannot degrade and
-- would sit in the report looking like one that never did.
alter table txn add column bin_bucket text;

create index txn_cohort_idx on txn (issuer_id, rail, failed_at desc);

-- ---------------------------------------------------------------------------
-- The authorisation stream
-- ---------------------------------------------------------------------------
-- Both outcomes. This is the table that makes a rate computable, and it is deliberately
-- NOT `sim_gateway_log`: that one records charges the ENGINE made during recovery, is
-- simulator scaffolding the engine may not read, and is a consequence of our own actions.
-- Detecting degradation in a stream you generated yourself measures your own retry policy.
-- This is the merchant's own inbound traffic, which the agent observes and does not cause.

create table auth_attempt (
  id           bigserial   primary key,
  batch_id     uuid        not null references batch(id) on delete cascade,

  -- Cohort keys. Denormalised on purpose: a detector scans this table by cohort and window
  -- and must not join to reach the grouping columns, because the scan is the hot path and
  -- the cohort is the entire query.
  issuer_id    text        not null,
  rail         text        not null check (rail in ('card','upi_collect','upi_intent','netbanking','wallet')),
  bin_bucket   text,

  succeeded    boolean     not null,
  amount_paise bigint      not null check (amount_paise > 0),

  -- The gateway's own code, for the root-cause step. A cohort can degrade for more than one
  -- reason and the response differs: mass `issuer_down` says switch rail, mass
  -- `suspected_fraud_block` says stop and escalate, because retrying into a fraud rule is
  -- both futile and how a merchant gets its acquirer relationship reviewed.
  gateway_code text,

  occurred_at  timestamptz not null,

  -- Set on the failed rows that opened a recovery case, so a detected cohort can be joined
  -- to the transactions inside it. Null on successes, and on failures the merchant chose
  -- not to pursue.
  txn_id       uuid        references txn(id) on delete set null,

  -- A success is not a recovery case. Without this, a bug that linked one would put a
  -- collected payment into the recovery population and inflate every rate downstream.
  constraint auth_success_has_no_case check (succeeded is false or txn_id is null)
);

-- The detector's access pattern, exactly: one cohort, one time range.
create index auth_attempt_cohort_idx on auth_attempt (batch_id, issuer_id, rail, occurred_at);
create index auth_attempt_window_idx on auth_attempt (batch_id, occurred_at);

-- Immutable, like every other record of something that happened. An authorisation attempt
-- is a fact about the past; if it could be rewritten, a detection could be made to agree
-- with a signal that was fired for different reasons.
create trigger auth_attempt_no_mutation
  before update or delete on auth_attempt
  for each row execute function rc_reject_mutation();

-- ---------------------------------------------------------------------------
-- What the detector concluded
-- ---------------------------------------------------------------------------
-- Persisted for the same reason refusals are: a signal that changed a recovery decision is
-- part of the audit trail for that decision. "Why did this transaction switch rails on
-- attempt one instead of retrying?" has to be answerable months later, and the answer is a
-- row here — with the counts and the bound it was computed from, not just its verdict.

create table degradation_signal (
  id             bigserial   primary key,
  batch_id       uuid        not null references batch(id) on delete cascade,

  issuer_id      text        not null,
  rail           text        not null,
  bin_bucket     text,

  window_start   timestamptz not null,
  window_end     timestamptz not null,

  -- When the detector could FIRST have concluded this: the close of the earliest window that
  -- fired. Distinct from window_end, which coalescing extends to cover the whole episode --
  -- reading a detection lag off that would report 90 minutes for something caught in 30.
  first_seen_at  timestamptz not null,

  -- The evidence, stored so the verdict can be recomputed and disputed. A stored conclusion
  -- with no stored inputs is an assertion.
  attempts       integer     not null check (attempts > 0),
  failures       integer     not null check (failures >= 0),
  observed_bps   integer     not null check (observed_bps between 0 and 10000),
  baseline_bps   integer     not null check (baseline_bps between 0 and 10000),
  -- Lower bound of the Wilson interval on the observed failure rate. The alert fired because
  -- THIS exceeded the baseline, not because the point estimate did — which is what makes a
  -- three-attempt cohort unable to trigger one.
  lower_bound_bps integer    not null check (lower_bound_bps between 0 and 10000),

  -- Which cause the cohort's failures concentrated on, when they concentrated at all. This
  -- is the "root cause" in the brief's arrow, and it is what selects the response.
  dominant_code  text        references reason_code(code),

  -- What the signal licenses. Narrower than "something is wrong": an outage says re-present
  -- elsewhere, a fraud-rule trip says stop presenting entirely.
  verdict        text        not null check (verdict in ('issuer_outage', 'fraud_rule', 'rail_degraded')),

  detected_at    timestamptz not null default now(),

  constraint degradation_failures_within_attempts check (failures <= attempts),
  -- A signal whose lower bound sits at or under the baseline is not evidence of anything,
  -- and storing one would let a future change to the threshold quietly widen what counts as
  -- a detection without any test noticing.
  constraint degradation_clears_baseline check (lower_bound_bps > baseline_bps),
  constraint degradation_window_ordered check (window_end > window_start)
);

create index degradation_signal_batch_idx  on degradation_signal (batch_id, detected_at);
create index degradation_signal_cohort_idx on degradation_signal (batch_id, issuer_id, rail);

create trigger degradation_signal_no_mutation
  before update or delete on degradation_signal
  for each row execute function rc_reject_mutation();

-- ---------------------------------------------------------------------------
-- The bounds a signal creates
-- ---------------------------------------------------------------------------
-- Two new members of `AttemptBound` in @rc/policy, recorded in `decision.refuse_rule`:
--
--   issuer_degraded    the cohort is in a detected outage, so re-presenting on the same
--                      rail is a fee paid into a system that is down
--   fraud_rule_active  the cohort's failures concentrated on a fraud rule; re-presenting
--                      is futile, and at volume it is how a merchant's acquirer
--                      relationship gets reviewed
--
-- Deliberately NOT added as a database vocabulary here. `refuse_rule` is governed by
-- `decision_refusal_names_its_rule`, which asserts COHERENCE — a refusal names a rule and a
-- firing decision does not — and the closed set lives in the TypeScript union. Replacing
-- that coherence check with an enumeration would trade a guarantee that holds for every
-- value for one that holds only for the values someone remembered to list.

comment on column decision.refuse_rule is
  'The specific bound that refused this decision. Closed set, defined by AttemptBound and '
  'ContactBound in @rc/policy — including issuer_degraded and fraud_rule_active, which come '
  'from a population-level detection rather than from anything visible in the transaction.';
