import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, isDatabaseReachable, type Db } from '@rc/db';
import { loadPolicy, loadPriorTable } from '@rc/policy';
import { generateBatch, loadTruthModel } from '@rc/simulator';
import { armById } from './arms.js';
import { computeMetrics } from './metrics.js';
import { runArm } from './runner.js';
import { simulateArm } from './sweep.js';

/**
 * Skip rather than fail when Postgres is not running.
 *
 * These tests exist to check things only a real database can check — triggers, CHECK
 * constraints, FOR UPDATE SKIP LOCKED. Somebody who has not started Docker yet should be
 * told that, not handed a wall of connection errors that looks like broken code.
 */
const DATABASE_UP = await isDatabaseReachable();
if (!DATABASE_UP) {
  console.warn(
    `
  SKIPPED: Postgres unreachable. Run \`docker compose up -d\` to run these tests.
`,
  );
}

/**
 * THE SWEEP REPRODUCES THE PERSISTED RUN.
 *
 * The sensitivity analysis only means anything if it is measuring THIS system rather than a
 * lookalike that happens to share its shape. An in-memory replay that quietly scheduled
 * attempts differently, or drew different coin flips, would produce a confident robustness
 * figure about a system nobody ships.
 *
 * So this asserts parity on the two quantities that cannot drift without the simulations
 * having diverged: how many attempts fired, and how many recovered. Both are exact.
 *
 * Net value is NOT asserted equal, and the gap is fully accounted for: the sweep excludes
 * customer messaging, because the truth model has no notion of a customer responding to a
 * nudge and including it would add cost and no recovery to every arm alike. The test bounds
 * that difference instead, so an unexplained divergence still fails.
 */

let db: Db;
let close: () => Promise<void>;

const SEED = 424_242;
const COUNT = 200;

/**
 * A fresh world per run.
 *
 * A fixed name would collide on `batch(seed, arm, world)` the second time the suite ran,
 * and — because `decision` and `audit` are delete-protected by design — it could not clean
 * up after itself. A suite that needs a pristine database is a suite that fails for whoever
 * runs it second, which at a hackathon is the judge.
 */
const WORLD = `parity-${Math.floor(Math.random() * 1_000_000_000)}`;

beforeAll(async () => {
  ({ db, close } = createDb());
  await generateBatch(db, { seed: SEED, arm: 'rc', world: WORLD, count: COUNT });
});

afterAll(async () => {
  await close();
});

describe.skipIf(!DATABASE_UP)('in-memory sweep vs the database runner', () => {
  it('fires the same attempts and recovers the same transactions', async () => {
    const policy = loadPolicy();
    const priors = loadPriorTable();

    const persisted = await runArm({
      db,
      seed: SEED,
      arm: 'rc',
      world: WORLD,
      policy,
      priors,
    });

    const inMemory = simulateArm({
      seed: SEED,
      count: COUNT,
      policy,
      priors,
      truth: loadTruthModel(),
      arm: armById('rc'),
    });

    // Exact. The outcome draw is keyed on each attempt's own idempotency key, derived
    // identically on both paths, so the coin flips are the same coin flips.
    expect(inMemory.fired).toBe(persisted.fired);
    expect(inMemory.recovered).toBe(persisted.succeeded);
  });

  it('agrees on net value once messaging is accounted for', async () => {
    const policy = loadPolicy();
    const priors = loadPriorTable();

    const metrics = await computeMetrics(db, {
      seed: SEED,
      arm: 'rc',
      world: WORLD,
      priors,
    });

    const inMemory = simulateArm({
      seed: SEED,
      count: COUNT,
      policy,
      priors,
      truth: loadTruthModel(),
      arm: armById('rc'),
    });

    // The sweep omits message cost, so it should sit exactly that much ABOVE the persisted
    // net. Asserting the direction and the magnitude turns "the numbers are close" into a
    // statement that would fail if anything else had drifted.
    const difference = inMemory.net - metrics.net;
    expect(difference).toBe(metrics.messageCosts);
  });
});
