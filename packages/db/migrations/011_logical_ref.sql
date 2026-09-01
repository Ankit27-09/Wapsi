-- 011_logical_ref.sql
--
-- A transaction's position in the seeded population, independent of which world it was
-- materialised into.
--
-- WHY: THE ABLATION WAS NOT A CONTROLLED COMPARISON.
--
-- Each ablation arm gets its own world (`abl-oracle`, `abl-keyword`, `abl-llm`) so the arms
-- cannot contaminate one another's attempt counts and contact ceilings. But transaction ids
-- are derived as `deterministicId('txn', seed, arm, world, index)`, the attempt idempotency
-- key hashes the transaction id, and the simulator seeds each outcome draw from that key —
-- so the three arms faced THREE DIFFERENT SETS OF COIN FLIPS.
--
-- Part of the measured gap between the keyword and model arms was therefore luck rather
-- than classification quality. The observed difference was five recoveries out of sixty-odd,
-- which is comfortably inside the noise that different coin flips produce. That is the exact
-- mistake already caught and fixed in the threshold sweep, repeated in the place where it
-- mattered most: the headline claim about what the model is worth.
--
-- `logical_ref` is the same for the same transaction in every world, so keying outcome draws
-- on it gives every arm the identical coin flips. A difference between arms is then
-- attributable to the arm.
--
-- Transaction IDs stay world-scoped — they are primary keys and must not collide. Identity
-- and the random stream are simply different concerns, and conflating them is what caused
-- this.

alter table txn
  add column logical_ref text;

-- Existing rows predate the column and belong to batches that have already been evaluated;
-- there is no meaningful position to backfill, so they get their own id and the constraint
-- applies from here on.
update txn set logical_ref = id::text where logical_ref is null;

alter table txn
  alter column logical_ref set not null;

-- One transaction per position per batch.
create unique index txn_logical_ref_uq on txn (batch_id, logical_ref);

comment on column txn.logical_ref is
  'Position in the seeded population, identical across worlds. Outcome draws key on this '
  'rather than on the primary key, so every arm and every world faces the same coin flips '
  'and a difference between them is attributable to the strategy. See 011_logical_ref.sql.';
