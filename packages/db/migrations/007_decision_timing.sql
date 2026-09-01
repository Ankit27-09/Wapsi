-- 007_decision_timing.sql
--
-- Record which timing bucket a decision chose.
--
-- Found while writing reconciliation. After a crash, resolving a `pending` decision means
-- rebuilding the request that was sent to the gateway — and that request carries the
-- timing. Without this column the reconciler would have to guess it, which on this system
-- means guessing the success probability that was priced.
--
-- It belongs here on its own merits regardless: "attempt 2, at salary_window" is the
-- decision's rationale in two words, and the exception queue and the report both want it
-- without having to parse an audit payload for it.
--
-- Nullable, because a refusal chose no timing. The CHECK ties the two facts together so a
-- fired decision cannot exist without one.

alter table decision
  add column planned_timing text
    check (planned_timing in (
      'immediate', 'short_backoff', 'medium_backoff', 'next_day', 'salary_window', 'alt_rail'
    ));

-- A fired decision must say when it was placed; a refusal must not claim to have chosen.
-- Both halves are enforced, so neither can be forgotten by a future code path.
alter table decision
  add constraint decision_fire_has_timing check (
    (verdict = 'fire') = (planned_timing is not null)
  );

comment on column decision.planned_timing is
  'The timing bucket this attempt was scheduled into, matching priors.published.yaml. '
  'Required for a fired decision, absent for a refusal.';
