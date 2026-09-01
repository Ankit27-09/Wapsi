-- 005_immutability.sql
--
-- Append-only tables, enforced by the database.
--
-- The brief claims an append-only audit trail. This file is the difference between that
-- being a claim and being a fact: with these triggers in place, no application bug, no
-- ORM convenience method and no future contributor can rewrite history through the
-- normal interface. Demonstrating it takes one UPDATE in psql on stage.

-- ---------------------------------------------------------------------------
-- The rejection function
-- ---------------------------------------------------------------------------

create or replace function rc_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Table %.% is append-only; % is not permitted',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation',
          hint = 'Record a new row describing the change instead of altering the old one.';
end;
$$;

comment on function rc_reject_mutation() is
  'Raises on any attempt to UPDATE, DELETE or TRUNCATE an append-only table. '
  'Attached to audit, consent_event and policy_version.';

-- ---------------------------------------------------------------------------
-- Attachment
-- ---------------------------------------------------------------------------
-- Row-level triggers catch UPDATE and DELETE. TRUNCATE bypasses row-level triggers
-- entirely, so it needs its own statement-level trigger — the omission most
-- "append-only" implementations make, and the one that lets a stray `truncate audit`
-- succeed silently.

do $$
declare
  tbl text;
begin
  foreach tbl in array array['audit', 'consent_event', 'policy_version']
  loop
    execute format(
      'create trigger %I_no_mutation
         before update or delete on %I
         for each row execute function rc_reject_mutation()',
      tbl, tbl
    );

    execute format(
      'create trigger %I_no_truncate
         before truncate on %I
         for each statement execute function rc_reject_mutation()',
      tbl, tbl
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- `decision` is mutable, but only along its state machine
-- ---------------------------------------------------------------------------
-- Decisions are not append-only: a fired decision legitimately moves
-- planned → pending → settled as the gateway responds. What must never change is the
-- decision itself — the transaction it belongs to, the policy version that authorised
-- it, its attempt number, its idempotency key, or the expected-value arithmetic that
-- justified it.
--
-- Freezing those columns is what stops a retry loop from quietly relabelling a refusal
-- as an action, or re-scoring a decision after seeing how it turned out. The state
-- column moves; the justification is history.

create or replace function rc_freeze_decision_identity()
returns trigger
language plpgsql
as $$
begin
  if new.txn_id          is distinct from old.txn_id
  or new.batch_id        is distinct from old.batch_id
  or new.policy_version  is distinct from old.policy_version
  or new.verdict         is distinct from old.verdict
  or new.attempt_no      is distinct from old.attempt_no
  or new.idempotency_key is distinct from old.idempotency_key
  or new.ev_p_bps        is distinct from old.ev_p_bps
  or new.ev_value_paise  is distinct from old.ev_value_paise
  or new.ev_cost_paise   is distinct from old.ev_cost_paise
  or new.ev_net_paise    is distinct from old.ev_net_paise
  then
    raise exception
      'decision %: identity and expected-value columns are immutable once written', old.id
      using errcode = 'restrict_violation',
            hint = 'Only `state` and `updated_at` may change after a decision is recorded.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger decision_identity_frozen
  before update on decision
  for each row execute function rc_freeze_decision_identity();

create trigger decision_no_delete
  before delete on decision
  for each row execute function rc_reject_mutation();

-- ---------------------------------------------------------------------------
-- One-way state machine
-- ---------------------------------------------------------------------------
-- A settled decision cannot return to pending. Without this, a crash-resume bug could
-- re-dispatch an attempt that already succeeded — which is the double-charge the
-- idempotency key exists to prevent, arriving through a different door.

create or replace function rc_guard_decision_state()
returns trigger
language plpgsql
as $$
begin
  if old.state = 'settled' and new.state <> 'settled' then
    raise exception 'decision %: settled is terminal, refusing transition to %', old.id, new.state
      using errcode = 'restrict_violation';
  end if;

  if old.state = 'abandoned' and new.state not in ('abandoned', 'settled') then
    raise exception 'decision %: abandoned may only be resolved to settled', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger decision_state_guarded
  before update on decision
  for each row execute function rc_guard_decision_state();

-- ---------------------------------------------------------------------------
-- Outcomes are written once
-- ---------------------------------------------------------------------------
-- The result of a gateway call is a fact about the past. If a reconciliation ever needs
-- to correct one, it records a new audit row explaining the correction rather than
-- editing the number that a reported total was computed from.

create trigger outcome_no_mutation
  before update or delete on outcome
  for each row execute function rc_reject_mutation();
