import {
  KEYWORD_CLASSIFIER,
  createLlmClassifier,
  isPricedModel,
  resolveProvider,
  type Classifier,
  type Provider,
} from '@rc/ai';
import { bps, formatINR, sub, type Paise } from '@rc/core';
import { createDb, type Db } from '@rc/db';
import { loadPolicy, loadPriorTable } from '@rc/policy';
import { allLabelledStrings, generateBatch } from '@rc/simulator';
import { calibrate, scoreClassifier, type AccuracyReport } from './ablation.js';
import { computeMetrics, formatRate, percentOfPaise } from './metrics.js';
import { ORACLE_CLASSIFY, runArm, type RunClassifier } from './runner.js';

/**
 * `pnpm ablate` — what is the model worth, in rupees?
 *
 * Two halves, reported together.
 *
 * ACCURACY answers "how often is the label right?", split by how hard the string is.
 * Cheap, needs no database, and is the number every other project would stop at.
 *
 * RUPEES answers "what does being wrong cost?" — by running the IDENTICAL policy over the
 * IDENTICAL seeded population with each classifier swapped in, and reporting net value.
 * A misclassification is not an abstract error here: it sends a recoverable payment down
 * the wrong schedule, or fires a fee against a revoked mandate. Currency is the correct
 * unit for a classifier inside a payments system.
 *
 * The oracle arm supplies the ceiling, so each real classifier is reported as a fraction
 * of what perfect labelling would have achieved. Without it, "the model recovered X%" is
 * a number with no scale.
 *
 * The honest outcome is whichever one the numbers give. If the keyword baseline captures
 * the same net value, the model does not belong in this loop, and that goes in the report.
 */

interface Env {
  /** Null when no key is configured, with `providerProblem` saying which. */
  readonly provider: Provider | null;
  readonly providerProblem: string | null;
  readonly usdInrPaise: number;
  readonly confidenceFloorBps: number;
  readonly seed: number;
  readonly count: number;
}

function readEnv(argv: readonly string[]): Env {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} expects a value`);
    flags.set(token.slice(2), value);
  }

  // Which vendor, and which model, comes from the environment — `LLM_PROVIDER` and
  // `LLM_MODEL`, or the first provider with a usable key. Placeholders from `.env.example`
  // are treated as absent, so a copied example file skips the arm cleanly instead of
  // running it and failing on authentication three minutes in.
  const resolution = resolveProvider();

  if (resolution.provider !== null && !isPricedModel(resolution.provider.model)) {
    throw new Error(
      `LLM_MODEL is "${resolution.provider.model}", which has no published price in ` +
        `@rc/ai/cost.ts. Add it there rather than letting its calls cost nothing in the ` +
        `report — an unpriced model makes every rupee figure here quietly wrong.`,
    );
  }

  const seedRaw = flags.get('seed') ?? process.env['EVAL_SEED'] ?? '42';

  return {
    provider: resolution.provider,
    providerProblem: resolution.problem,
    usdInrPaise: Number.parseInt(process.env['USD_INR_PAISE'] ?? '8800', 10),
    confidenceFloorBps: Number.parseInt(
      process.env['CLASSIFY_CONFIDENCE_FLOOR_BPS'] ?? '6000',
      10,
    ),
    seed: Number.parseInt(seedRaw, 10),
    count: Number.parseInt(flags.get('count') ?? '300', 10),
  };
}

interface ArmResult {
  readonly label: string;
  readonly world: string;
  readonly accuracy: AccuracyReport | null;
  readonly transactions: number;
  readonly quarantined: number;
  readonly misclassified: number;
  readonly recovered: number;
  readonly recoverable: number;
  readonly recoveryRateBps: number;
  readonly net: Paise;
  readonly modelCost: Paise;
}

async function runClassifierArm(
  db: Db,
  env: Env,
  spec: {
    readonly label: string;
    readonly world: string;
    readonly classify: RunClassifier;
    readonly scorer: Classifier | null;
  },
): Promise<ArmResult> {
  const policy = loadPolicy();
  const priors = loadPriorTable();

  // Checked before seeding, so a repeat run reports something actionable instead of a raw
  // duplicate-key error from Postgres. It cannot clean up after itself: `decision` and
  // `audit` are delete-protected by design, and a cascade from `batch` fires those same
  // triggers — so a used world stays used.
  const existing = await db
    .selectFrom('batch')
    .select('id')
    .where('seed', '=', env.seed)
    .where('arm', '=', 'rc')
    .where('world', '=', spec.world)
    .executeTakeFirst();

  if (existing !== undefined) {
    throw new Error(
      `The "${spec.world}" world already exists for seed ${env.seed} and cannot be ` +
        `re-run: attempt numbering would continue rather than restart.\n` +
        `  Run \`pnpm db:reset\` first, then \`pnpm ablate\`.`,
    );
  }

  // Its own world, so each arm gets a freshly seeded copy of the identical population and
  // the arms cannot contaminate one another's attempt counts or contact ceilings.
  await generateBatch(db, {
    seed: env.seed,
    arm: 'rc',
    world: spec.world,
    count: env.count,
  });

  const run = await runArm({
    db,
    seed: env.seed,
    arm: 'rc',
    world: spec.world,
    policy,
    priors,
    classify: spec.classify,
  });

  const metrics = await computeMetrics(db, {
    seed: env.seed,
    arm: 'rc',
    world: spec.world,
    priors,
  });

  return {
    label: spec.label,
    world: spec.world,
    accuracy: spec.scorer === null ? null : await scoreClassifier(spec.scorer),
    transactions: run.transactions,
    quarantined: run.quarantined,
    misclassified: run.misclassified,
    recovered: metrics.recovered,
    recoverable: metrics.recoverable,
    recoveryRateBps: metrics.recoveryRateBps,
    net: metrics.net,
    modelCost: metrics.modelCosts,
  };
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
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...rows.map(render),
  ].join('\n');
}

async function main(): Promise<void> {
  const env = readEnv(process.argv.slice(2));
  const { db, close } = createDb();

  try {
    process.stdout.write(
      `\n  Classifier ablation\n` +
        `  seed ${env.seed} · ${env.count} transactions per arm · ` +
        `${allLabelledStrings().length} labelled strings\n\n`,
    );

    const results: ArmResult[] = [];

    results.push(
      await runClassifierArm(db, env, {
        label: 'oracle (ceiling)',
        world: 'abl-oracle',
        classify: ORACLE_CLASSIFY,
        scorer: null,
      }),
    );

    results.push(
      await runClassifierArm(db, env, {
        label: 'keyword',
        world: 'abl-keyword',
        classify: (input) => KEYWORD_CLASSIFIER.classify(input),
        scorer: KEYWORD_CLASSIFIER,
      }),
    );

    if (env.provider === null) {
      process.stdout.write(
        `  llm arm SKIPPED — ${env.providerProblem ?? 'no provider configured'}\n\n` +
          `  Every figure the model arm would report is ABSENT from this run rather than\n` +
          `  estimated. The keyword arm below stands on its own.\n\n`,
      );
    } else {
      const llm = createLlmClassifier({
        provider: env.provider,
        usdInrPaise: env.usdInrPaise,
        confidenceFloorBps: bps(env.confidenceFloorBps),
      });

      results.push(
        await runClassifierArm(db, env, {
          label: `llm (${env.provider.id}:${env.provider.model})`,
          world: 'abl-llm',
          classify: (input) => llm.classify(input),
          scorer: llm,
        }),
      );
    }

    reportAccuracy(results);
    reportCalibration(results);
    reportRupees(results);
  } finally {
    await close();
  }
}

function reportAccuracy(results: readonly ArmResult[]): void {
  const scored = results.filter((result) => result.accuracy !== null);
  if (scored.length === 0) return;

  process.stdout.write('  Accuracy, on the labelled corpus\n\n');
  process.stdout.write(
    table(
      ['arm', 'acc', 'macroF1', 'easy', 'hard', 'opaque', 'quarantined'],
      scored.map((result) => {
        const a = result.accuracy;
        if (a === null) throw new Error('unreachable: filtered');
        const tier = (part: { correct: number; total: number }): string =>
          part.total === 0 ? '—' : formatRate(Math.round((part.correct / part.total) * 10_000));
        return [
          a.method,
          formatRate(a.accuracyBps),
          formatRate(a.macroF1Bps),
          tier(a.byDifficulty.easy),
          tier(a.byDifficulty.hard),
          tier(a.byDifficulty.opaque),
          `${a.quarantined}/${a.total}`,
        ];
      }),
    ),
  );
  process.stdout.write('\n\n');
}

/**
 * Is the confidence trustworthy, and where should the threshold sit?
 *
 * Confidence decides whether the system acts or quarantines, so a number that says 0.9 and
 * is right 60% of the time spends money on a cause nobody identified. Reporting it turns
 * the threshold from a guess into a choice with a curve behind it.
 */
function reportCalibration(results: readonly ArmResult[]): void {
  const scored = results.filter((result) => result.accuracy !== null);
  if (scored.length === 0) return;

  process.stdout.write('  Calibration — does the classifier know when it is right?\n\n');

  for (const result of scored) {
    const accuracy = result.accuracy;
    if (accuracy === null) continue;
    const calibration = calibrate(accuracy);

    process.stdout.write(
      `  ${calibration.method}  ECE ${formatRate(calibration.eceBps)}  ` +
        `${
          calibration.overconfidenceBps > 0
            ? `OVERCONFIDENT by ${formatRate(calibration.overconfidenceBps)}`
            : `under-confident by ${formatRate(-calibration.overconfidenceBps)}`
        }\n\n`,
    );

    process.stdout.write(
      table(
        ['stated confidence', 'n', 'mean stated', 'actual accuracy'],
        calibration.bins.map((bin) => [
          `${formatRate(bin.lowerBps)}–${formatRate(Math.min(bin.upperBps, 10_000))}`,
          String(bin.count),
          formatRate(bin.meanConfidenceBps),
          formatRate(bin.accuracyBps),
        ]),
      ),
    );
    process.stdout.write('\n\n');

    process.stdout.write(
      table(
        ['act above', 'coverage', 'accuracy of what we act on', 'acted and wrong'],
        calibration.operatingPoints.map((point) => [
          formatRate(point.thresholdBps),
          formatRate(point.coverageBps),
          formatRate(point.accuracyBps),
          String(point.actedAndWrong),
        ]),
      ),
    );
    process.stdout.write('\n\n');
  }

  process.stdout.write(
    `  Overconfidence is the dangerous direction: it produces action where quarantine was\n` +
      `  warranted. "Acted and wrong" is the column that costs money — each one is a fee\n` +
      `  spent executing a plan built for a different failure.\n\n`,
  );
}

/**
 * The half that matters: what imperfect labelling costs once the policy acts on it.
 */
function reportRupees(results: readonly ArmResult[]): void {
  const ceiling = results.find((result) => result.world === 'abl-oracle');
  if (ceiling === undefined) throw new Error('The oracle arm must run: it is the ceiling.');

  process.stdout.write('  Net value, identical policy and population, classifier swapped\n\n');
  process.stdout.write(
    table(
      ['arm', 'recovered', 'rate', 'quarantined', 'mislabelled', 'model cost', 'NET', '% of ceiling'],
      results.map((result) => [
        result.label,
        `${result.recovered}/${result.recoverable}`,
        formatRate(result.recoveryRateBps),
        String(result.quarantined),
        String(result.misclassified - result.quarantined),
        formatINR(result.modelCost),
        formatINR(result.net),
        percentOfPaise(result.net, ceiling.net),
      ]),
    ),
  );
  process.stdout.write('\n\n');

  for (const result of results) {
    if (result.world === 'abl-oracle') continue;
    const gap = sub(ceiling.net, result.net);
    process.stdout.write(
      `  ${result.label}: ${formatINR(gap)} of net value lost to classification error,\n` +
        `  against ${formatINR(result.modelCost)} spent on classifying.\n`,
    );
  }

  process.stdout.write(
    `\n  The mislabelled column excludes quarantines. A quarantine forgoes an\n` +
      `  opportunity; a wrong label spends a fee on the wrong action. Both are\n` +
      `  departures from the true cause, and only one of them costs money to make.\n\n`,
  );
}

await main();
