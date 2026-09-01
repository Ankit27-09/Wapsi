-- 008_decision_clock.sql
--
-- Let the application own `decision.updated_at`.
--
-- THE BUG THIS FIXES, because it was invisible until reconciliation got a test.
--
-- Every timestamp in this system comes from the caller: the eval harness runs on SIMULATED
-- time so that a run is reproducible on any machine at any hour, and `evaluated_at`,
-- `settled_at` and `occurred_at` are all passed in explicitly for that reason.
--
-- `updated_at` was the exception. It defaulted to `now()` on insert and the freeze trigger
-- overwrote it with `now()` on every update — real wall-clock time, in a table where
-- everything else was simulated. `reconcileStranded` computes its lease cutoff from the
-- simulated clock, so it was comparing a June cutoff against an August timestamp and the
-- claim query matched nothing. Crash-resume would have silently never reconciled during a
-- demo, while passing every unit test, because nothing else read the column.
--
-- The fix is the standard touch-trigger shape: stamp the clock only when the application
-- did NOT set the value itself. Production gets `now()` for free; a simulated run stays on
-- one clock.

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

  -- Respect an explicitly supplied timestamp; stamp the wall clock only when the caller
  -- left it alone. Without this branch the trigger silently pulls one column of a
  -- simulated run onto a different clock from every other column in the same row.
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;

  return new;
end;
$$;

comment on column decision.updated_at is
  'Owned by the application. Callers pass the same clock they use for evaluated_at, so a '
  'simulated run stays reproducible; the trigger stamps now() only when a caller does not '
  'set it. See 008_decision_clock.sql.';
