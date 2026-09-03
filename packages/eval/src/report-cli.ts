import { mkdir, writeFile } from 'node:fs/promises';
import { KEYWORD_CLASSIFIER } from '@rc/ai';
import { PaiseSchema, ZERO, add, formatINR, type Paise } from '@rc/core';
import { createDb, type Arm as ArmId, type Db } from '@rc/db';
import { buildPolicy, loadPolicy, loadPriorTable } from '@rc/policy';
import { loadSignals, scoreDetection } from '@rc/detect';
import {
  SIM_EPOCH,
  createRng,
  loadTruthModel,
  materialOutages,
  perturbedTruth,
} from '@rc/simulator';
import { scoreInjections } from './injection.js';
import { calibrate, scoreClassifier } from './ablation.js';
import { armById, ARMS } from './arms.js';
import { hostileWorlds } from './hostile.js';
import { computeMetrics, formatRate, percentOfPaise, type ArmMetrics } from './metrics.js';
import {
  barChart,
  escapeXml,
  histogram,
  lineChart,
  reliabilityDiagram,
} from './report-charts.js';
import { runSweep, simulateArm } from './sweep.js';

/**
 * `pnpm report` — one self-contained page of evidence.
 *
 * Written to `artifacts/report.html` with no external stylesheet, no script, and no network
 * call, so it opens from a `file://` URL on a machine that has never seen this project.
 *
 * The ordering is the argument. Results first, then the ceiling that gives them scale, then
 * the evidence that the result is not an artefact of the author's own assumptions, and
 * finally — at length, not in a footnote — every transaction the system refused to act on
 * and why. Most submissions show their wins; the exception list is the part that earns
 * trust, so it gets room.
 */

const OUT_DIR = 'artifacts';
const OUT_FILE = `${OUT_DIR}/report.html`;

interface ExceptionRow {
  readonly reasonCode: string;
  readonly verdict: string;
  /** The bound that refused it, from `decision.refuse_rule`. */
  readonly rule: string;
  readonly detail: string;
  readonly pBps: number;
  readonly value: Paise;
  readonly cost: Paise;
  readonly net: Paise;
  readonly count: number;
}

/**
 * Every refusal, grouped by cause and rule, with the arithmetic that produced it.
 *
 * Grouped rather than listed one row per decision: five hundred rows is a data dump, and
 * the thing a reader needs is the PATTERN plus a representative figure. The full per-row
 * detail lives in the `decision` table for anyone who wants it.
 */
async function gatherExceptions(
  db: Db,
  args: { readonly seed: number; readonly arm: ArmId },
): Promise<readonly ExceptionRow[]> {
  const rows = await db
    .selectFrom('decision')
    .innerJoin('batch', 'batch.id', 'decision.batch_id')
    .select([
      'decision.reason_code as reason_code',
      'decision.verdict as verdict',
      'decision.refuse_detail as refuse_detail',
      'decision.refuse_rule as refuse_rule',
      'decision.ev_p_bps as ev_p_bps',
      'decision.ev_value_paise as ev_value_paise',
      'decision.ev_cost_paise as ev_cost_paise',
      'decision.ev_net_paise as ev_net_paise',
    ])
    .where('batch.seed', '=', args.seed)
    .where('batch.arm', '=', args.arm)
    .where('batch.world', '=', 'base')
    .where('decision.verdict', '!=', 'fire')
    .execute();

  const groups = new Map<string, { rows: typeof rows; count: number }>();
  for (const row of rows) {
    // Grouped on the RECORDED rule, not on a guess parsed out of the prose.
    //
    // This used to call a `ruleOf(detail)` helper that matched substrings of the English
    // explanation — "since the last attempt" means min_gap, and so on. It worked, and it was
    // a maintenance trap: it knew nothing about consent, quiet hours, the contact ceiling,
    // the pre-debit notice or an open promise, so every one of those landed in a bucket
    // labelled `other` and the exception list stopped distinguishing the refusals an operator
    // most needs to tell apart. `decision.refuse_rule` exists so this is a column read.
    const key = `${row.reason_code}|${row.verdict}|${row.refuse_rule ?? 'unrecorded'}`;
    const group = groups.get(key) ?? { rows: [], count: 0 };
    group.count += 1;
    if (group.rows.length === 0) group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const sample = group.rows[0];
      if (sample === undefined) throw new Error('unreachable: empty group');
      return {
        reasonCode: sample.reason_code,
        verdict: sample.verdict,
        rule: sample.refuse_rule ?? 'unrecorded',
        detail: sample.refuse_detail ?? '',
        pBps: sample.ev_p_bps,
        value: PaiseSchema.parse(sample.ev_value_paise),
        cost: PaiseSchema.parse(sample.ev_cost_paise),
        net: PaiseSchema.parse(sample.ev_net_paise),
        count: group.count,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * The value frontier: net value against how aggressive the policy is permitted to be.
 *
 * Swept by varying the expected-value floor — a low floor acts on almost anything, a high
 * one only on near-certainties. The shipped floor is marked, and the point of drawing it is
 * to show the chosen setting sits near the peak rather than merely asserting that it does.
 */
function valueFrontier(count: number, seed: number): {
  readonly points: readonly { x: number; y: number }[];
  readonly marker: { x: number; y: number };
} {
  const base = loadPolicy();
  const priors = loadPriorTable();
  const truth = loadTruthModel();
  const points: { x: number; y: number }[] = [];

  for (let floor = 0; floor <= 3000; floor += 150) {
    const policy = buildPolicy(base.yaml.replace(/ev_floor_paise: \d+/, `ev_floor_paise: ${floor}`));
    const result = simulateArm({
      seed,
      count,
      policy,
      priors,
      truth,
      arm: armById('rc'),
    });
    points.push({ x: floor, y: Number(result.net) / 100 });
  }

  const shipped = simulateArm({
    seed,
    count,
    policy: base,
    priors,
    truth,
    arm: armById('rc'),
  });

  return { points, marker: { x: Number(base.evFloor), y: Number(shipped.net) / 100 } };
}

/**
 * Failure rate per (issuer, rail) across the whole authorisation stream.
 *
 * The report needs the cohorts that were NOT flagged as much as the ones that were: a table
 * of detections alone cannot distinguish a detector that found two real problems from one
 * that alerts on everything and happened to be right twice.
 */
async function cohortRates(
  db: Db,
  batchId: string,
): Promise<readonly { issuer: string; rail: string; attempts: number; failures: number }[]> {
  const rows = await db
    .selectFrom('auth_attempt')
    .select(({ fn }) => [
      'issuer_id',
      'rail',
      fn.countAll<string>().as('attempts'),
      fn.count<string>('id').filterWhere('succeeded', '=', false).as('failures'),
    ])
    .where('batch_id', '=', batchId)
    .groupBy(['issuer_id', 'rail'])
    .execute();

  return rows
    .map((row) => ({
      issuer: row.issuer_id,
      rail: row.rail,
      attempts: Number.parseInt(row.attempts, 10),
      failures: Number.parseInt(row.failures, 10),
    }))
    .sort((a, b) => b.failures / b.attempts - a.failures / a.attempts);
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = headers.map((h) => `<th>${escapeXml(h)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function main(): Promise<void> {
  const seed = Number.parseInt(process.env['EVAL_SEED'] ?? '42', 10);
  const count = 300;
  const { db, close } = createDb();
  const policy = loadPolicy();
  const priors = loadPriorTable();

  try {
    process.stdout.write('\n  Building report…\n');

    // ---- arms, from the persisted run ------------------------------------
    const metrics: ArmMetrics[] = [];
    for (const arm of ARMS) {
      metrics.push(await computeMetrics(db, { seed, arm: arm.id, world: 'base', priors }));
    }
    const ceiling = metrics.find((m) => m.arm === 'b3_oracle');
    const rc = metrics.find((m) => m.arm === 'rc');
    if (ceiling === undefined || rc === undefined) {
      throw new Error('Run `pnpm demo` first — the report reads the persisted five-arm run.');
    }

    // ---- sweep, hostile worlds, frontier, calibration ---------------------
    process.stdout.write('  running 500-world sweep…\n');
    const sweep = runSweep({
      seed,
      count,
      draws: 500,
      policy,
      priors,
      worldFor: (draw) => perturbedTruth(createRng(seed + draw * 7919), { bandPct: 60 }),
    });

    const hostile = hostileWorlds().map((world) => ({
      world,
      result: simulateArm({
        seed,
        count,
        policy,
        priors,
        truth: world.truth,
        arm: armById('rc'),
        ...(world.labelCorruptionBps === undefined
          ? {}
          : { labelCorruptionBps: world.labelCorruptionBps }),
      }),
    }));

    process.stdout.write('  sweeping the value frontier…\n');
    const frontier = valueFrontier(count, seed);

    const keyword = await scoreClassifier(KEYWORD_CLASSIFIER);
    const calibration = calibrate(keyword);

    const exceptions = await gatherExceptions(db, { seed, arm: 'rc' });

    // ---- detection, and how it behaved under attack -----------------------
    // Both read the run that already happened rather than re-deriving anything, so the report
    // cannot disagree with the database it claims to describe.
    const rcBatch = await db
      .selectFrom('batch')
      .select('id')
      .where('seed', '=', seed)
      .where('arm', '=', 'rc')
      .where('world', '=', 'base')
      .executeTakeFirstOrThrow();

    const signals = await loadSignals(db, rcBatch.id);
    const detection = scoreDetection(signals, materialOutages(loadTruthModel().outages, SIM_EPOCH));
    const cohorts = await cohortRates(db, rcBatch.id);
    const injections = await scoreInjections(KEYWORD_CLASSIFIER, 'keyword');

    // ---- render -----------------------------------------------------------
    const html = render({
      seed,
      count,
      policy,
      metrics,
      ceiling,
      rc,
      sweep,
      hostile,
      frontier,
      keyword,
      calibration,
      exceptions,
      signals,
      detection,
      cohorts,
      injections,
    });

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(OUT_FILE, html, 'utf8');

    process.stdout.write(
      `\n  ${OUT_FILE} — ${(html.length / 1024).toFixed(0)} KB, self-contained.\n` +
        `  Opens from file:// with no network.\n\n`,
    );
  } finally {
    await close();
  }
}

interface RenderArgs {
  readonly seed: number;
  readonly count: number;
  readonly policy: ReturnType<typeof loadPolicy>;
  readonly metrics: readonly ArmMetrics[];
  readonly ceiling: ArmMetrics;
  readonly rc: ArmMetrics;
  readonly sweep: ReturnType<typeof runSweep>;
  readonly hostile: readonly {
    readonly world: ReturnType<typeof hostileWorlds>[number];
    readonly result: ReturnType<typeof simulateArm>;
  }[];
  readonly frontier: ReturnType<typeof valueFrontier>;
  readonly keyword: Awaited<ReturnType<typeof scoreClassifier>>;
  readonly calibration: ReturnType<typeof calibrate>;
  readonly exceptions: readonly ExceptionRow[];
  readonly signals: Awaited<ReturnType<typeof loadSignals>>;
  readonly detection: ReturnType<typeof scoreDetection>;
  readonly cohorts: Awaited<ReturnType<typeof cohortRates>>;
  readonly injections: Awaited<ReturnType<typeof scoreInjections>>;
}

function render(args: RenderArgs): string {
  const armLabel: Record<string, string> = {
    b0: 'B0 · do nothing',
    b1: 'B1 · retry all, immediately',
    b2: 'B2 · fixed-schedule dunning',
    b4: 'B4 · blast reminders at everything',
    b3_oracle: 'B3 · oracle (ceiling)',
    rc: 'RC · Recovery Controller',
  };

  const armsTable = table(
    ['arm', 'recovered', 'rate', '₹ value recovered', '₹ cost', '₹ net', '% of ceiling'],
    args.metrics.map((m) => [
      escapeXml(armLabel[m.arm] ?? m.arm),
      `${m.recovered}/${m.recoverable}`,
      formatRate(m.recoveryRateBps),
      formatINR(m.valueRecovered),
      formatINR(m.cost),
      `<strong>${formatINR(m.net)}</strong>`,
      // Value recovered against the oracle's, not net against net. The oracle assumes every
      // customer is reachable and pays for messages the controller's consent bounds suppress,
      // which made net-against-net exceed 100% on two classes — impossible for a ceiling.
      `<strong>${percentOfPaise(m.valueRecovered, args.ceiling.valueRecovered)}</strong>`,
    ]),
  );

  const riskClassTable = table(
    ['risk class', 'txns', 'fired', 'recovered', 'refused', '₹ net', '₹ ceiling', '% of ceiling'],
    args.rc.byRiskClass
      .filter((slice) => slice.transactions > 0)
      .map((slice) => {
        const ceilingSlice = args.ceiling.byRiskClass.find(
          (c) => c.riskClass === slice.riskClass,
        );
        return [
          `<code>${escapeXml(slice.riskClass)}</code>`,
          String(slice.transactions),
          String(slice.attemptsFired),
          `${slice.recovered}/${slice.recoverable}`,
          String(slice.refused),
          `<strong>${formatINR(slice.net)}</strong>`,
          ceilingSlice === undefined ? '—' : formatINR(ceilingSlice.valueRecovered),
          ceilingSlice === undefined
            ? '—'
            : `<strong>${percentOfPaise(slice.valueRecovered, ceilingSlice.valueRecovered)}</strong>`,
        ];
      }),
  );

  const guardrailTotal = args.rc.forgoneByRule.reduce((sum, row) => add(sum, row.forgone), ZERO);

  const guardrailTable = table(
    ['rule', 'refusals', '₹ expected recovery forgone', 'share'],
    args.rc.forgoneByRule.map((row) => [
      `<code>${escapeXml(row.rule)}</code>`,
      String(row.count),
      formatINR(row.forgone),
      percentOfPaise(row.forgone, guardrailTotal),
    ]),
  );

  const wasteTable = table(
    ['arm', 'negative-EV attempts', '₹ spent on them'],
    args.metrics
      .filter((m) => m.attemptsFired > 0)
      .map((m) => [
        escapeXml(armLabel[m.arm] ?? m.arm),
        `${m.negativeEvAttempts} of ${m.attemptsFired}`,
        formatINR(m.negativeEvSpend),
      ]),
  );

  const hostileTable = table(
    ['world', 'assumption falsified', '₹ net', 'fired', 'recovered', 'downside'],
    [
      [
        '<em>(shipped)</em>',
        '—',
        formatINR(args.rc.net),
        String(args.rc.attemptsFired),
        String(args.rc.recovered),
        '—',
      ],
      ...args.hostile.map(({ world, result }) => [
        `<strong>${escapeXml(world.id)}</strong> ${escapeXml(world.label)}`,
        escapeXml(world.assumption),
        formatINR(result.net),
        String(result.fired),
        String(result.recovered),
        result.net < ZERO
          ? '<span class="bad">DESTROYS VALUE</span>'
          : '<span class="good">bounded</span>',
      ]),
    ],
  );

  const exceptionsTable = table(
    ['count', 'reason code', 'verdict', 'rule', 'p', '₹ at stake', '₹ cost', '₹ net', 'why'],
    args.exceptions.map((row) => [
      String(row.count),
      escapeXml(row.reasonCode),
      escapeXml(row.verdict),
      `<code>${escapeXml(row.rule)}</code>`,
      formatRate(row.pBps),
      formatINR(row.value),
      formatINR(row.cost),
      formatINR(row.net),
      `<span class="detail">${escapeXml(row.detail)}</span>`,
    ]),
  );

  const calibrationTable = table(
    ['act above', 'coverage', 'accuracy of what we act on', 'acted and wrong'],
    args.calibration.operatingPoints.map((point) => [
      formatRate(point.thresholdBps),
      formatRate(point.coverageBps),
      formatRate(point.accuracyBps),
      String(point.actedAndWrong),
    ]),
  );

  const refusedTotal = args.exceptions.reduce((sum, row) => sum + row.count, 0);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recovery Controller — evidence</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 30px; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 19px; margin: 56px 0 6px; padding-top: 20px; border-top: 1px solid #21262d; }
  h3 { font-size: 15px; margin: 28px 0 6px; color: #7d8590; font-weight: 600; }
  p  { margin: 10px 0; color: #c9d1d9; }
  .sub { color: #7d8590; margin: 0 0 28px; font-size: 14px; }
  .lede { font-size: 17px; color: #e6edf3; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 13px;
          font-variant-numeric: tabular-nums; }
  th { text-align: right; padding: 8px 10px; color: #7d8590; font-weight: 600;
       border-bottom: 1px solid #30363d; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  td { text-align: right; padding: 8px 10px; border-bottom: 1px solid #161b22;
       font-family: ui-monospace, SFMono-Regular, monospace; }
  .detail { color: #7d8590; font-size: 12px; }
  /* A caveat that qualifies the table above it — the definitional footnotes a reader needs
     in order to trust a number, set quieter than the claim itself. */
  .aside { color: #8b949e; font-size: 13.5px; border-left: 2px solid #30363d;
           padding-left: 14px; margin: 16px 0; }
  .good { color: #3fb950; } .bad { color: #f85149; } .warn { color: #d29922; }
  .callout { border-left: 3px solid #2f81f7; background: #10161f; padding: 14px 18px;
             margin: 22px 0; border-radius: 0 6px 6px 0; }
  .callout.warn { border-left-color: #d29922; }
  .grid { display: grid; grid-template-columns: 340px 1fr; gap: 24px; align-items: start; }
  figure { margin: 18px 0; }
  figcaption { color: #7d8590; font-size: 13px; margin-top: 8px; }
  code { background: #161b22; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
</style></head><body><main>

<h1>Recovery Controller</h1>
<p class="sub">Expected-value gated payment recovery with a bounded, self-improving policy ·
seed ${args.seed} · ${args.count} transactions · policy v${args.policy.version}
(<code>${escapeXml(args.policy.hash.slice(0, 12))}</code>)</p>

<div class="callout warn">
  <strong>What these numbers are, before you ask.</strong> Simulated outcomes against a
  probability model the policy engine <em>cannot read</em> — the published priors it decides
  with and the ground truth it is graded against are separately authored tables, and the
  build fails if the policy package can reach the simulator. That makes the comparison an
  inference rather than an identity. It does not make the priors themselves correct; the
  sensitivity section below is what addresses that.
</div>

<h2>Results</h2>
${armsTable}

<figure>${barChart(
    args.metrics.map((m) => ({
      label: m.arm,
      value: Math.max(0, Number(m.net)),
      caption: formatINR(m.net),
      highlight: m.arm === 'rc',
    })),
  )}<figcaption>Net value: contribution margin recovered, minus every rupee spent.</figcaption></figure>

<p>The Recovery Controller captures
<strong>${percentOfPaise(args.rc.valueRecovered, args.ceiling.valueRecovered)}</strong> of what
perfect play could have achieved. The oracle sees the per-issuer effect no real policy can
observe, evaluates every timing and every intervention available, and plays optimally against
the true outcome distribution — so its ${formatRate(args.ceiling.recoveryRateBps)} recovery
rate is genuinely unreachable, which is the point of a ceiling. It turns "we beat naive retry"
into a claim with a scale attached, and it makes the shortfall explicit rather than absent.</p>

<p class="aside"><strong>% of ceiling is value recovered against the oracle's, not net against
net.</strong> The oracle assumes every customer is reachable, so it sends messages the
controller's consent bounds suppress — and pays for them. On a class where both recover the
same transactions, that extra postage made net-against-net exceed 100%, which is impossible
for a ceiling and was the symptom of a real definitional problem. Cost stays in the table
beside it, where a difference in spending is visible rather than baked into the ratio.</p>

<h3>Attempts fired at negative expected value</h3>
<p>Priced against the <em>published</em> priors — the evidence available beforehand, not
hindsight. The controller's zero is structural: the gate refuses them.</p>
${wasteTable}

<h2>Detection — before any decision was made</h2>
<p>The brief's first verb. Everything above measures what the agent DID; this is what it
noticed first, and it is a different kind of evidence: the rest of this report could be
produced by a well-tuned rules engine, and this section could not, because no per-transaction
rule can see a cohort going bad.</p>

<p><strong>${args.cohorts.reduce((total, c) => total + c.attempts, 0).toLocaleString('en-IN')}</strong>
authorisations watched across <strong>${args.cohorts.length}</strong> cohorts, both outcomes.
The successes are not decoration — they are the denominator, and without them no rate is
computable and "detects revenue at risk" cannot be true of a queue of failures.</p>

${table(
    ['cohort', 'verdict', 'observed', 'peer baseline', 'lower bound', 'n', 'knew after', 'root cause'],
    args.signals.map((signal) => [
      `<code>${signal.issuerId}</code> ${signal.rail}`,
      `<code>${signal.verdict}</code>`,
      formatRate(signal.observedBps),
      formatRate(signal.baselineBps),
      formatRate(signal.lowerBoundBps),
      String(signal.attempts),
      `${Math.round((signal.firstSeenAt.getTime() - signal.windowStart.getTime()) / 60_000)} min`,
      `<code>${signal.dominantCode ?? '—'}</code>`,
    ]),
  )}

<p class="lede">Against the episodes the simulator actually created — which the detector cannot
see — recall <strong>${formatRate(args.detection.recallBps)}</strong>
(${args.detection.found} of ${args.detection.outages}), precision
<strong>${formatRate(args.detection.precisionBps)}</strong>
(${args.detection.falsePositives} false positive${args.detection.falsePositives === 1 ? '' : 's'}),
mean detection delay <strong>${
    args.detection.meanDelayMinutes === null
      ? '—'
      : `${args.detection.meanDelayMinutes.toFixed(0)} min`
  }</strong>.</p>

<h3>Every cohort, including the ones left alone</h3>
<p>Restraint is the harder half, and a table of detections alone cannot show it. One episode in
<code>priors.truth.yaml</code> is marked <code>material: false</code> — a real elevation, on real
volume, that is not worth moving anybody's traffic over. Reporting it costs precision; missing it
costs nothing. A detector tuned until this page looked impressive fails there.</p>

${table(
    ['issuer', 'rail', 'authorisations', 'failure rate', 'reported?'],
    args.cohorts.slice(0, 12).map((cohort) => {
      const flagged = args.signals.some(
        (signal) => signal.issuerId === cohort.issuer && signal.rail === cohort.rail,
      );
      return [
        `<code>${cohort.issuer}</code>`,
        cohort.rail,
        cohort.attempts.toLocaleString('en-IN'),
        formatRate(Math.round((cohort.failures / cohort.attempts) * 10_000)),
        flagged ? '<strong>reported</strong>' : 'within peers',
      ];
    }),
  )}

<div class="callout">
  <strong>The verdict decides the cure, and two of them are opposites.</strong>
  <code>issuer_outage</code> forbids re-presenting on that rail and lets a switch through —
  the detection changes the <em>action</em>, which is what "root cause → recovery action"
  means. <code>fraud_rule</code> forbids the switch too, because a fraud decline travels with
  the card rather than the rail: evading one is futile, and at volume it is how a merchant's
  acquirer relationship gets reviewed. Getting that precedence backwards would have the system
  hammer a risk engine working exactly as intended.
</div>

<h2>Under attack</h2>
<p><code>gateway_description</code> is untrusted free text that flows into a model prompt, and a
misclassification spends money. Five attacks are planted in the corpus and each one declares the
label it is trying to force, so &ldquo;was it steered&rdquo; is answerable rather than
rhetorical.</p>

${table(
    ['attack shape', 'demanded', 'produced', 'steered?'],
    args.injections.outcomes.map((outcome) => [
      `<code>${outcome.kind}</code>`,
      outcome.demands === null ? 'a policy change, not a label' : `<code>${outcome.demands}</code>`,
      `<code>${outcome.assigned}</code>`,
      outcome.steered ? '<strong>yes</strong>' : 'no',
    ]),
  )}

<p class="lede"><strong>${args.injections.steered} of ${args.injections.steerable}</strong>
steerable attacks produced the label the attacker named, against
<code>${args.injections.classifier}</code>.
<strong>${args.injections.escapedTaxonomy}</strong> produced a code outside the taxonomy.</p>

<div class="callout warn">
  <strong>This is a finding, not a boast.</strong> The keyword baseline has no
  instruction-following surface, so it cannot be <em>persuaded</em> — and it is steered anyway,
  by the simplest attack available: write the label you want into the text and a keyword matcher
  will match it. Same outcome, cheaper attack. So the free classifier is not the safe choice
  here — it is the one that loses to a single line of text, which belongs beside its share of
  the ceiling (see <code>pnpm ablate</code>) rather than buried.
</div>

<div class="callout">
  <strong>What the structural defences do and do not cover.</strong> Two layers hold
  absolutely. Output is validated against the taxonomy before anything reads it, and
  <code>classification.reason_code</code> is a foreign key to the seeded
  <code>reason_code</code> table — so a code outside the eighteen cannot be stored, let alone
  acted on. And a cause only ever <em>indexes into</em> the policy: it selects a schedule row,
  it cannot become one, which is why the attack demanding &ldquo;unlimited retries&rdquo; has
  nothing to attack — the schedule comes from the policy YAML and no classifier output will
  change it. Neither layer covers being steered to a label that IS in the taxonomy but wrong,
  which spends a real fee on the wrong strategy. That is the residual risk, and the table above
  is its size.
</div>

<p class="aside"><strong>Measured against the corpus, not against the persisted run, and the
reason is worth stating.</strong> The first version of this section read the batch — join the
planted descriptions to their classifications and count the steered ones. It reported zero, and
that zero was vacuous: <code>pnpm eval</code> classifies with the <em>oracle</em>, which reads
the simulator's seeded cause and never looks at the description. An attack cannot steer a
classifier that does not read it, so the number measured nothing while looking exactly like a
security result. Run <code>pnpm ablate</code> to measure the model path the same way.</p>

<h2>One engine, five kinds of revenue at risk</h2>
<p>Failed payments, failed subscription cycles, lapsed mandates, abandoned checkouts and
overdue B2B invoices. The classes differ in exactly three ways — which causes are possible,
which interventions are legal, and how value and cost are computed — and all three were
already inputs the expected-value gate took. So the differences are data rather than code
paths, and every class inherits one decision path, one audit trail, one set of bounds and one
evaluation harness.</p>

<p>A single blended figure cannot tell "works across five domains" from "works on payments and
loses money on receivables", and the aggregate is exactly where a per-class failure would
hide. Each class is therefore reported against the oracle's ceiling <em>for that class</em>.</p>

${riskClassTable}

${
    args.rc.lifetimeValuePreserved > ZERO
      ? `<p class="aside">Plus <strong>${formatINR(args.rc.lifetimeValuePreserved)}</strong> of
subscription value preserved beyond the recovered cycle — reported separately and never folded
into net. Net is margin on money that has moved; that figure is margin on cycles a saved
subscription will pay <em>if</em> it runs its expected term. It is the basis the gate priced
on, which is why it is shown at all, but it rests on an assumption and the headline should
not.</p>`
      : ''
  }

<h2>What the guardrails cost</h2>
<p>The obvious question about the table above is why the messaging-only classes trail. The
answer is a number rather than a paragraph: every refusal records <em>which rule</em> refused
it, and each one is valued at the expected recovery it gave up.</p>

${guardrailTable}

<div class="callout">
  <strong>${formatINR(guardrailTotal)} across ${args.rc.forgoneByRule.reduce(
    (n, row) => n + row.count,
    0,
  )} refusals — and most of it is consent.</strong>
  Forty percent of the seeded customer book has either opted out or never opted in. Checkout
  abandonment and overdue receivables recover money by messaging and nothing else — there is no
  charge to re-present — so a customer who cannot be messaged cannot be recovered, and the
  oracle is permitted to message them while the controller is not.
  <br><br>
  This is the price of the compliance envelope, not a list of bugs.
  <code>attempt_cap</code> and <code>terminal</code> forgo exactly ₹0, which is the gate
  working: those refusals decline actions whose expected recovery was already zero.
  <code>ev_floor</code> is the one line here a merchant is actually free to move.
</div>

<h2>The value frontier</h2>
<figure>${lineChart(args.frontier.points, {
    xLabel: 'expected-value floor (paise) — lower is more aggressive →',
    yLabel: 'net value',
    marker: args.frontier.marker,
    markerLabel: 'shipped',
    formatY: (v) => `₹${Math.round(v).toLocaleString('en-IN')}`,
  })}<figcaption>Net value against how aggressive the policy is permitted to be, swept by
varying the expected-value floor. Do-nothing sits at the far right where nothing clears the
bar; acting on everything sits at the left. The marked point is the shipped setting.</figcaption></figure>

<h2>Sensitivity — does the conclusion survive a different world?</h2>
<p>Every ground-truth probability perturbed independently by up to <strong>±60%</strong>,
500 times. The truth table carries no citations, so it gets the widest band — and it is the
<em>truth</em> that is perturbed rather than the policy's beliefs, because the question is
whether the result survives the world not being what its author invented.</p>

<figure>${histogram(
    args.sweep.controllerNets.map((net) => Number(net) / 100),
    { formatX: (v) => `₹${Math.round(v).toLocaleString('en-IN')}` },
  )}<figcaption>Distribution of the controller's net value across ${args.sweep.draws}
perturbed worlds.</figcaption></figure>

<p class="lede">The controller beat the best baseline in
<strong>${args.sweep.controllerWins} of ${args.sweep.draws}</strong> worlds
(${formatRate(args.sweep.winShareBps)}). Worst ${formatINR(args.sweep.worstControllerNet)},
median ${formatINR(args.sweep.medianControllerNet)}, best
${formatINR(args.sweep.bestControllerNet)}.</p>

<div class="callout warn">
  <strong>This is a weaker result than it looks.</strong> Perturbing each prior independently
  means the noise largely averages out across ${args.count} transactions, so a high win share
  is close to guaranteed by construction. The sharper test is a world where one assumption is
  <em>systematically</em> false — which is the next section, and where the success criterion
  is not winning.
</div>

<h2>Hostile worlds</h2>
<p>One assumption systematically false. <strong>Success here is not that the controller still
wins</strong> — that would be a claim about luck. It is that the expected-value gate notices
attempts are not paying and stops, bounding the downside near do-nothing, which nets exactly
zero.</p>
${hostileTable}

<h2>Is the model worth its place?</h2>
<div class="grid">
  <figure>${reliabilityDiagram(args.calibration.bins)}<figcaption>Reliability: stated
  confidence against observed accuracy. The dashed diagonal is perfect calibration; points
  below it are overconfidence, the direction that spends money.</figcaption></figure>
  <div>
    <p>The keyword baseline scores ${formatRate(args.keyword.accuracyBps)} accuracy
    (${formatRate(args.keyword.macroF1Bps)} macro-F1) with an expected calibration error of
    ${formatRate(args.calibration.eceBps)}. Its ${args.keyword.quarantined} quarantines are
    not errors: on the opaque tier the cause is genuinely absent from the text, and returning
    <code>unknown</code> is the correct behaviour.</p>
    <p>The threshold is chosen from this table rather than by feel — and note that raising it
    can make accuracy <em>worse</em> while cutting coverage.</p>
  </div>
</div>
${calibrationTable}

<h2>The exception list</h2>
<p class="lede">${refusedTotal} actions the Recovery Controller refused to take, grouped by
cause and rule, each with the arithmetic that produced it.</p>
<p>This is the section most submissions leave out. A refusal that cannot say what it would
have been worth is a log line; one that can is an audit record, and it is why the decision
table stores expected value on rows where nothing happened.</p>
${exceptionsTable}

<h2>Limitations</h2>
<p>Stated here rather than discovered in review.</p>
<ul>
  <li>Outcomes come from a simulator, not a live gateway. The sensitivity section quantifies
  how much that matters; it does not remove it.</li>
  <li>Priors marked <code>ASSUMED</code> carry no citation and are given the widest
  perturbation band. Honesty is mechanised rather than promised.</li>
  <li>Messaging is compliant and exercised — DLT-registered templates, consent, quiet hours,
  contact ceilings — but its <em>effectiveness</em> is not modelled. The messages cost money
  in the net value above and recover none of it.</li>
  <li>Durability is stateless workers plus Postgres state, not Temporal. That covers most of
  what a real deployment needs and is honestly short of the rest.</li>
  <li>Single-tenant. Merchant onboarding, key management and per-merchant policy isolation
  are out of scope.</li>
</ul>

<p class="sub" style="margin-top:48px">Generated by <code>pnpm report</code>. Reproduce with
<code>pnpm demo &amp;&amp; pnpm report</code>; a different <code>--seed</code> gives different
transactions and materially similar conclusions.</p>

</main></body></html>`;
}

await main();
