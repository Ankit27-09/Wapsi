-- 009_oracle_method.sql
--
-- Give the oracle classifier its own method value.
--
-- The ablation has four arms and the CHECK constraint allowed three, so the oracle was
-- borrowing `llm_open_world`. That is not a cosmetic mislabel: the report groups
-- classification results by method, and an arm that exists to be the CEILING would have
-- been aggregated together with an arm that exists to handle NOVEL STRINGS. Every figure
-- derived from that grouping would have been wrong in a way no test would catch, because
-- both values are spelled correctly.
--
-- `oracle` is deliberately not shippable and the schema now says so in the comment: it
-- reads the simulator's seeded cause, and no production path can supply one.

alter table classification
  drop constraint classification_method_check;

alter table classification
  add constraint classification_method_check
    check (method in ('keyword', 'llm', 'llm_open_world', 'oracle'));

comment on column classification.method is
  'Which ablation arm produced this label. `keyword` is the rule-table baseline, `llm` is '
  'the model, `llm_open_world` adds clustering of unrecognised strings, and `oracle` reads '
  'the simulator''s seeded cause — a measurement ceiling, not a deployable strategy.';
