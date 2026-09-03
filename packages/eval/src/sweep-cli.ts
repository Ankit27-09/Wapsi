import { formatINR } from '@rc/core';
import { loadPolicy, loadPriorTable } from '@rc/policy';
import {
  baselineTruthValue,
  createRng,
  loadTruthModel,
  perturbedTruth,
  truthWithOverride,
} from '@rc/simulator';
import { armById } from './arms.js';
import { hostileWorlds } from './hostile.js';
import { formatRate } from './metrics.js';
import { runSweep, simulateArm } from './sweep.js';

/**
 * `pnpm sweep` â€” does the conclusion survive the world being different?
 *
 * Two questions, and the second is the more useful one.
 *
 *   ROBUSTNESS: in what share of five hundred perturbed worlds does Wapsi
 *   still produce more net value than the best baseline?
 *
 *   THRESHOLD: at what value of the single most load-bearing assumption does that stop
 *   being true? A percentage says the result is robust; a named boundary says *go and
 *   measure this one number first*, which is what someone deciding whether to trust this
 *   actually needs.
 */

/**
 * The assumption the whole strategy leans on.
 *
 * Insufficient funds is the largest single failure class in the batch, and the controller's
 * advantage over a fixed cadence rests almost entirely on placing its second attempt after
 * the customer's credit lands. If that lift is small, the targeting is worth little â€” so
 * this is the figure to walk.
 */
const LOAD_BEARING = {
  reasonCode: 'insufficient_funds',
  attempt: 2,
  timing: 'salary_window',
} as const;

const IMMEDIATE_BASELINE = {
  reasonCode: 'insufficient_funds',
  attempt: 1,
  timing: 'immediate',
} as const;

function parseArgs(argv: readonly string[]): { seed: number; count: number; draws: number } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} expects a value`);
    flags.set(token.slice(2), value);
  }

  return {
    seed: Number.parseInt(flags.get('seed') ?? process.env['EVAL_SEED'] ?? '42', 10),
    count: Number.parseInt(flags.get('count') ?? '300', 10),
    draws: Number.parseInt(flags.get('draws') ?? '500', 10),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy();
  const priors = loadPriorTable();

  process.stdout.write(
    `\n  Sensitivity sweep â€” seed ${args.seed}, ${args.count} transactions, ` +
      `${args.draws} worlds\n` +
      `  Every ground-truth probability perturbed independently by up to Â±60%.\n` +
      `  The truth table carries no citations, so it gets the widest band.\n\n`,
  );

  // ---- robustness ---------------------------------------------------------
  const started = performance.now();
  const report = runSweep({
    seed: args.seed,
    count: args.count,
    draws: args.draws,
    policy,
    priors,
    worldFor: (draw) => perturbedTruth(createRng(args.seed + draw * 7919), { bandPct: 60 }),
  });
  const elapsed = Math.round(performance.now() - started);

  process.stdout.write(
    `  The controller beat the best baseline in ` +
      `${report.controllerWins} of ${report.draws} worlds ` +
      `(${formatRate(report.winShareBps)}).\n\n` +
      `    worst   ${formatINR(report.worstControllerNet).padStart(14)}\n` +
      `    median  ${formatINR(report.medianControllerNet).padStart(14)}\n` +
      `    best    ${formatINR(report.bestControllerNet).padStart(14)}\n\n` +
      `  ${args.draws} worlds x 4 arms x ${args.count} transactions in ${elapsed} ms.\n\n`,
  );

  // ---- threshold ----------------------------------------------------------
  reportThreshold(args, policy, priors);

  // ---- hostile worlds -----------------------------------------------------
  reportHostileWorlds(args, policy, priors);
}

/**
 * Worlds where one assumption is systematically false.
 *
 * Reported against do-nothing rather than against the other baselines, because the question
 * here is not "does it still win" â€” it is "when the premise is wrong, does the gate stop, or
 * does it keep spending?" A controller that lands near zero has bounded its own downside;
 * one that lands well below zero has not, and that is the finding either way.
 */
function reportHostileWorlds(
  args: { seed: number; count: number },
  policy: ReturnType<typeof loadPolicy>,
  priors: ReturnType<typeof loadPriorTable>,
): void {
  process.stdout.write(
    `  Hostile worlds â€” one assumption systematically false\n` +
      `  Success is DEGRADING GRACEFULLY, not still winning: the expected-value gate\n` +
      `  should notice attempts are not paying and stop near do-nothing.\n\n`,
  );

  const baseline = simulateArm({
    seed: args.seed,
    count: args.count,
    policy,
    priors,
    truth: loadTruthModel(),
    arm: armById('rc'),
  });

  const rows: string[][] = [
    ['(shipped world)', formatINR(baseline.net), String(baseline.fired), String(baseline.recovered), 'â€”'],
  ];

  for (const world of hostileWorlds()) {
    const result = simulateArm({
      seed: args.seed,
      count: args.count,
      policy,
      priors,
      truth: world.truth,
      arm: armById('rc'),
      ...(world.labelCorruptionBps === undefined
        ? {}
        : { labelCorruptionBps: world.labelCorruptionBps }),
    });

    // Do-nothing always nets exactly zero: no attempts, no fees. So the sign of the
    // controller's net value IS the graceful-degradation test.
    const verdict = result.net < 0n ? 'DESTROYS VALUE' : 'bounded';

    rows.push([
      `${world.id} ${world.label}`,
      formatINR(result.net),
      String(result.fired),
      String(result.recovered),
      verdict,
    ]);
  }

  process.stdout.write(
    table(['world', 'rc net', 'fired', 'recovered', 'downside'], rows),
  );

  for (const world of hostileWorlds()) {
    process.stdout.write(`\n  ${world.id}: ${world.assumption}`);
  }
  process.stdout.write('\n\n');
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => {
        const width = widths[i] ?? cell.length;
        return i === 0 ? cell.padEnd(width) : cell.padStart(width);
      })
      .join('  ');

  return [
    render(headers),
    widths.map((w) => 'â”€'.repeat(w)).join('  '),
    ...rows.map(render),
  ].join('\n');
}

/**
 * Walk the load-bearing assumption until the conclusion breaks.
 *
 * Reported as a MULTIPLE of the immediate-retry probability rather than as a raw figure,
 * because the lift is what the strategy trades on: retrying after a credit lands versus
 * retrying straight away. "It fails below 1.4x" is checkable against real data in a way
 * that "it fails below 2,600 bps" is not.
 */
function reportThreshold(
  args: { seed: number; count: number },
  policy: ReturnType<typeof loadPolicy>,
  priors: ReturnType<typeof loadPriorTable>,
): void {
  const immediate = baselineTruthValue(IMMEDIATE_BASELINE);
  const shipped = baselineTruthValue(LOAD_BEARING);
  const arms = ['b0', 'b1', 'b2', 'rc'].map((id) => armById(id as 'rc'));

  process.stdout.write(
    `  Threshold on the load-bearing assumption\n` +
      `  ${LOAD_BEARING.reasonCode}, attempt ${LOAD_BEARING.attempt}, ` +
      `${LOAD_BEARING.timing} â€” shipped at ${shipped} bps, ` +
      `${(shipped / immediate).toFixed(2)}x the immediate retry.\n\n`,
  );

  // COMMON RANDOM NUMBERS across every point on the curve.
  //
  // They come for free: `simulateArm` keys every outcome on the attempt's own idempotency
  // key, so each transaction faces the same coin flip at every lift and the only thing
  // varying along the curve is the parameter. An earlier version varied the random stream
  // per point, and the curve swung by more than a lakh between adjacent multiples —
  // sampling noise being read as parameter sensitivity, which is precisely the mistake this
  // whole exercise exists to avoid.
  const LOWEST = 2; // 0.2x â€” the salary window being WORSE than an immediate retry
  const HIGHEST = 40; // 4.0x
  let firstWin: number | null = null;
  let lastLoss: number | null = null;

  for (let tenths = LOWEST; tenths <= HIGHEST; tenths += 1) {
    const pBps = Math.round((immediate * tenths) / 10);
    const truth = truthWithOverride({ ...LOAD_BEARING, pBps });

    const results = arms.map((arm) =>
      simulateArm({
        seed: args.seed,
        count: args.count,
        policy,
        priors,
        truth,
        arm,
      }),
    );

    const controller = results.find((result) => result.arm === 'rc');
    if (controller === undefined) throw new Error('unreachable: rc arm missing');

    const bestBaseline = results
      .filter((result) => result.arm !== 'rc')
      .reduce((best, result) => (result.net > best.net ? result : best));

    const wins = controller.net > bestBaseline.net;
    if (wins) firstWin ??= tenths;
    else lastLoss = tenths;

    if (tenths % 5 === 0 || tenths === LOWEST) {
      process.stdout.write(
        `    ${(tenths / 10).toFixed(1)}x  rc ${formatINR(controller.net).padStart(14)}  ` +
          `best baseline ${formatINR(bestBaseline.net).padStart(14)}  ` +
          `${wins ? 'controller wins' : 'BASELINE WINS'}\n`,
      );
    }
  }

  const range = `${(LOWEST / 10).toFixed(1)}xâ€“${(HIGHEST / 10).toFixed(1)}x`;

  if (lastLoss === null) {
    // Reported as what it is â€” no boundary inside the range â€” rather than dressed up as
    // one. Claiming a crossover at the bottom of the tested interval would be reading the
    // edge of the search as a property of the system.
    process.stdout.write(
      `\n  NO CROSSOVER in ${range}. The controller wins even where the salary window is\n` +
        `  five times WORSE than an immediate retry, which says the advantage does not rest\n` +
        `  on this assumption: most of it comes from refusing attempts that cannot pay for\n` +
        `  themselves, not from timing the ones that can.\n` +
        `  The honest caveat is that the boundary lies outside the tested range, wherever\n` +
        `  it is â€” not that there isn't one.\n\n`,
    );
    return;
  }

  process.stdout.write(
    firstWin === null
      ? `\n  The controller did not win anywhere in ${range}. That is a finding and it goes\n` +
          `  in the report as one.\n\n`
      : `\n  The controller stops winning below a ${(lastLoss / 10 + 0.1).toFixed(1)}x lift.\n` +
          `  That is the assumption this result depends on, and the first figure to check\n` +
          `  against real gateway data.\n\n`,
  );
}

// Fully synchronous: the sweep runs in memory and never touches the database, which is
// what makes 600,000 transaction-runs finish in seconds rather than hours.
main();
