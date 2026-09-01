-- 001_foundation.sql
--
-- Customers, consent, and the batch/budget pair that makes fee spend atomically
-- bounded. Forward-only migrations: every file is applied once, in order, and never
-- edited after it has run anywhere. A schema change is a new file.

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
-- Every row here is synthetic and generated from a seed. There is no path in this
-- system by which real customer data enters, which is stated in the README and is why
-- the repository can be public.

create table customer (
  id            uuid        primary key default gen_random_uuid(),
  external_ref  text        not null unique,
  display_name  text        not null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Consent — an append-only ledger, not a boolean on the customer row
-- ---------------------------------------------------------------------------
-- A flag records only the present. A ledger records when consent was given, through
-- which channel, on what basis, and when it was withdrawn — which is what a regulator
-- or a complaint actually asks for. It also makes withdrawal irreversible by
-- construction: you cannot un-opt-out by updating a column, because updates are
-- rejected (see 004_immutability.sql).

create table consent_event (
  id           bigserial   primary key,
  customer_id  uuid        not null references customer(id),
  channel      text        not null check (channel in ('sms', 'whatsapp', 'email')),
  state        text        not null check (state in ('opt_in', 'opt_out')),
  source       text        not null,
  recorded_at  timestamptz not null default now()
);

create index consent_event_lookup_idx
  on consent_event (customer_id, channel, recorded_at desc);

-- Current consent is derived from the ledger rather than stored alongside it. One
-- source of truth: there is no second place that can disagree, and therefore no
-- reconciliation job and no drift.
create view consent_current as
select distinct on (customer_id, channel)
       customer_id,
       channel,
       state,
       recorded_at
from   consent_event
order  by customer_id, channel, recorded_at desc, id desc;

-- ---------------------------------------------------------------------------
-- Batches — one evaluation run of one arm in one world
-- ---------------------------------------------------------------------------
-- `arm` is which strategy ran; `world` is which reality it ran against. Keeping them
-- separate is what allows the sensitivity sweep to reuse the same five arms across
-- five hundred perturbed parameter sets without inventing five hundred arm names.

create table batch (
  id             uuid        primary key default gen_random_uuid(),
  seed           integer     not null,
  arm            text        not null check (arm in ('rc', 'b0', 'b1', 'b2', 'b3_oracle')),
  world          text        not null default 'base',
  policy_version integer,
  record_count   integer     not null default 0,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,

  -- Reproducibility, enforced: the same (seed, arm, world) cannot be recorded twice
  -- with different numbers. An eval that would overwrite a prior run fails instead.
  unique (seed, arm, world)
);

-- ---------------------------------------------------------------------------
-- Fee budget — the one maintained counter in the system
-- ---------------------------------------------------------------------------
-- Everything else (attempt counts, contact counts, recovery totals) is derived by
-- query, because a derived value cannot drift from its source. This is the exception:
-- a spend ceiling must be checked and debited in the same transaction that records the
-- action, or two concurrent workers can each observe budget remaining and both spend
-- it. So the row is locked with SELECT ... FOR UPDATE and debited inline.
--
-- This is invariant I3 in the brief, and it is the reason the datastore is relational.

create table batch_budget (
  batch_id          uuid   primary key references batch(id) on delete cascade,
  fee_budget_paise  bigint not null check (fee_budget_paise >= 0),
  fee_spent_paise   bigint not null default 0 check (fee_spent_paise >= 0),

  -- The ceiling is a database constraint rather than an application check. If a code
  -- path ever forgets to consult the policy, the transaction still aborts.
  constraint batch_budget_not_exceeded check (fee_spent_paise <= fee_budget_paise)
);
