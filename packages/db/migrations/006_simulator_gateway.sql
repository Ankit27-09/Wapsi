-- 006_simulator_gateway.sql
--
-- The simulated gateway's own records.
--
-- SCAFFOLDING, not product. In a real deployment this table does not exist: the gateway
-- is somebody else's service and `lookup` is an API call. It lives here because the
-- crash-resume demonstration requires the gateway's memory to SURVIVE THE WORKER PROCESS.
--
-- If these records were held in memory, killing the worker would also erase the gateway's
-- knowledge of what it had already charged — every reconciliation would find nothing, and
-- the demo would appear to work while proving the opposite of what it claims. A separate
-- table models the one property that matters: the gateway remembers, independently of us.
--
-- The engine never reads this. It reaches the gateway only through the `Gateway` interface
-- in @rc/engine, which is why the engine has no dependency on the simulator at all.

create table sim_gateway_log (
  -- The engine's idempotency key, as the gateway received it. Primary key, because that
  -- is precisely the deduplication a real gateway performs: a second request under a key
  -- it has seen returns the original outcome instead of charging again.
  idempotency_key  text        primary key,

  succeeded        boolean     not null,
  gateway_code     text,
  fee_paise        bigint      not null check (fee_paise >= 0),
  recovered_paise  bigint      not null check (recovered_paise >= 0),

  -- Kept for the report: which world and which arm produced this charge.
  batch_id         uuid        references batch(id) on delete cascade,
  received_at      timestamptz not null default now(),

  constraint sim_recovery_requires_success check (succeeded or recovered_paise = 0)
);

create index sim_gateway_log_batch_idx on sim_gateway_log (batch_id);

-- Immutable, for the same reason `outcome` is: a charge is a fact about the past. If the
-- gateway could rewrite one, a reconciliation could disagree with the charge it reconciled
-- and no reported total would be defensible.
create trigger sim_gateway_log_no_mutation
  before update or delete on sim_gateway_log
  for each row execute function rc_reject_mutation();
