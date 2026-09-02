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
 * WHAT MAKING THAT EXACT COST, because it was not free and the debugging is the interesting
 * part. The sweep used to hand every arm a universal registered template and `opt_in`
 * consent, on the grounds that messaging was excluded from it anyway. Once four of the five
 * risk classes recovered money by messaging, that shortcut meant the sweep was measuring the
 * robustness of a system in which nobody had opted out and every template existed. Three
 * things had to become genuinely shared rather than approximately similar:
 *
 *   The POPULATION. Consent, language and the NCPR flag moved into `planTxns`, so both paths
 *   read one book of customers instead of drawing their own.
 *
 *   The TEMPLATE RESOLUTION. The sweep resolves the step's template and language variant from
 *   the same seed list the database is seeded from, so it cannot send what the run cannot.
 *
 *   The ORDER. Contact ceilings are per customer, so processing order decides which sends are
 *   permitted. The runner tied on the primary key — a hash, unreproducible in memory — and
 *   the two paths disagreed by exactly one attempt in two hundred. Both now tie on the
 *   generation index.
 *
 * Net value is NOT asserted equal, and the difference is exact and deliberate rather than
 * bounded: a recovered subscription is scored on the horizon basis in the sweep and on the
 * cash basis in the report. See below.
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

  it('differs on net value by exactly the subscription horizon, and nothing else', async () => {
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

    // ONE accounted-for difference, asserted exactly.
    //
    // The sweep scores a recovered subscription cycle at `margin x remaining cycles` — the
    // same basis the expected-value gate priced the decision on, because scoring a decision
    // on one basis and its outcome on another makes every subscription action look like a
    // loss by construction. The report scores CASH: margin on money that has actually moved,
    // with the horizon reported beside it as its own clearly-labelled line.
    //
    // Both are defensible and they answer different questions. What matters here is that the
    // gap between them is *entirely* that choice, so this is an equality rather than a bound:
    // any other drift — a cost the sweep forgot to charge, a message the run suppressed and
    // the sweep sent — breaks it.
    const difference = inMemory.net - metrics.net;
    expect(difference).toBe(metrics.lifetimeValuePreserved);

    // And the horizon really is in play, so the assertion above is not passing on two zeroes.
    expect(metrics.lifetimeValuePreserved).toBeGreaterThan(0n);
  });
});
