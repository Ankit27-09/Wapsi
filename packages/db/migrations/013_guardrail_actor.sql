-- 013_guardrail_actor.sql
--
-- Let a guardrail be an actor in the audit trail.
--
-- `audit.actor` is a deliberately CLOSED vocabulary — policy_engine, worker, simulator,
-- llm:<model>, human:<id> — because an audit trail whose actor column accepts free text stops
-- being answerable to "who did this?" and becomes a second rationale field.
--
-- The model spend ceiling needed to write to it and could not, which is the constraint doing
-- its job: it caught an invented actor at the boundary rather than admitting one.
--
-- So the vocabulary is widened by exactly one member rather than opened. A ceiling that halts
-- a batch is genuinely none of the existing actors:
--
--   It is not `policy_engine`. The policy did not decide this; a budget did, and an operator
--   reading the trail needs to tell "the rules declined to act" apart from "we ran out of
--   money to think with". Those call for completely different responses.
--   It is not `worker`. The worker noticed and complied. Attributing it there records the
--   messenger.
--   It is not `human`. Nobody was asked.
--
-- `cost_ceiling` is specific rather than a generic `guardrail`, because a closed vocabulary is
-- only worth having if its members say something. A future control that halts a batch for a
-- different reason gets its own member and its own row in this comment.

alter table audit
  drop constraint audit_actor_check;

alter table audit
  add constraint audit_actor_check check (
    actor = 'policy_engine'
    or actor = 'worker'
    or actor = 'simulator'
    or actor = 'cost_ceiling'
    or actor like 'llm:%'
    or actor like 'human:%'
  );

comment on column audit.actor is
  'Who or what caused this event. A closed vocabulary: policy_engine (a rule decided), '
  'worker (execution), simulator (scaffolding), cost_ceiling (a budget halted the batch), '
  'llm:<model>, human:<id>. Free text here would make "who did this?" unanswerable.';
