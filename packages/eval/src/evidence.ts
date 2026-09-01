import { PaiseSchema, ZERO, add, formatINR, type Paise } from '@rc/core';
import type { Arm as ArmId, Db } from '@rc/db';

/**
 * WHAT THE PROPOSAL AGENT READS
 *
 * A rendering of the audit trail compact enough to reason over and specific enough to cite.
 *
 * The shape is deliberate. The agent is asked to justify every change with what actually
 * happened, so the summary leads with the two things that make a tuning argument: WHY
 * ATTEMPTS WERE REFUSED, and WHAT HAPPENED to the ones that fired, both broken down by
 * reason code and attempt number. A summary that only reported totals would leave the agent
 * nothing to cite and it would invent something plausible instead.
 *
 * Decision ids are included so the rationale is checkable. An agent that claims "41 attempts
 * were refused for min_gap" can be held to it, and a human reviewing the proposal can pull
 * those exact rows.
 */

export interface BatchEvidence {
  readonly summary: string;
  readonly totalNet: Paise;
  readonly decisions: number;
}

export async function gatherEvidence(
  db: Db,
  args: { readonly seed: number; readonly arm: ArmId; readonly world: string },
): Promise<BatchEvidence> {
  const batch = await db
    .selectFrom('batch')
    .select('id')
    .where('seed', '=', args.seed)
    .where('arm', '=', args.arm)
    .where('world', '=', args.world)
    .executeTakeFirstOrThrow(
      () => new Error(`No batch for seed ${args.seed}, arm ${args.arm}, world "${args.world}"`),
    );

  // ---- refusals, by code and rule -----------------------------------------
  // The most actionable half. A bound that fires constantly is either protecting the system
  // or strangling it, and which one it is shows in what the fired attempts recovered.
  const refusals = await db
    .selectFrom('decision')
    .select(['reason_code', 'verdict', 'refuse_detail', 'id'])
    .where('batch_id', '=', batch.id)
    .where('verdict', '!=', 'fire')
    .execute();

  const refusalGroups = new Map<string, { count: number; ids: string[]; sample: string }>();
  for (const row of refusals) {
    // The rule name is the leading clause of the detail; the numbers in it vary per row and
    // would fragment the grouping.
    const rule = ruleOf(row.refuse_detail ?? row.verdict);
    const key = `${row.reason_code} · ${row.verdict} · ${rule}`;
    const group = refusalGroups.get(key) ?? { count: 0, ids: [], sample: row.refuse_detail ?? '' };
    group.count += 1;
    if (group.ids.length < 4) group.ids.push(row.id);
    refusalGroups.set(key, group);
  }

  // ---- outcomes, by code, attempt and timing ------------------------------
  const outcomes = await db
    .selectFrom('outcome')
    .innerJoin('decision', 'decision.id', 'outcome.decision_id')
    .innerJoin('txn', 'txn.id', 'decision.txn_id')
    .select([
      'decision.reason_code as reason_code',
      'decision.attempt_no as attempt_no',
      'decision.planned_timing as planned_timing',
      'decision.id as decision_id',
      'outcome.success as success',
      'outcome.fee_paise as fee_paise',
      'outcome.recovered_paise as recovered_paise',
      'txn.margin_bps as margin_bps',
    ])
    .where('decision.batch_id', '=', batch.id)
    .execute();

  interface Cell {
    fired: number;
    recovered: number;
    fees: Paise;
    value: Paise;
    ids: string[];
  }

  const cells = new Map<string, Cell>();
  let totalNet = ZERO;

  for (const row of outcomes) {
    const key = `${row.reason_code} · attempt ${row.attempt_no ?? '?'} · ${row.planned_timing ?? '?'}`;
    const cell = cells.get(key) ?? { fired: 0, recovered: 0, fees: ZERO, value: ZERO, ids: [] };

    cell.fired += 1;
    cell.fees = add(cell.fees, PaiseSchema.parse(row.fee_paise));
    if (cell.ids.length < 4) cell.ids.push(row.decision_id);

    if (row.success) {
      cell.recovered += 1;
      const recovered = PaiseSchema.parse(row.recovered_paise);
      const margin = (recovered * BigInt(row.margin_bps)) / 10_000n;
      cell.value = add(cell.value, margin as Paise);
    }

    cells.set(key, cell);
  }

  for (const cell of cells.values()) {
    totalNet = add(totalNet, (cell.value - cell.fees) as Paise);
  }

  const firedLines = [...cells.entries()]
    .sort(([, a], [, b]) => b.fired - a.fired)
    .map(
      ([key, cell]) =>
        `  ${key}: fired ${cell.fired}, recovered ${cell.recovered}, ` +
        `fees ${formatINR(cell.fees)}, margin recovered ${formatINR(cell.value)} ` +
        `[${cell.ids.join(', ')}]`,
    );

  const refusalLines = [...refusalGroups.entries()]
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([key, group]) => `  ${key}: ${group.count} times [${group.ids.join(', ')}]`);

  return {
    summary: [
      'ATTEMPTS THAT FIRED (by reason code, attempt number, timing)',
      ...firedLines,
      '',
      'ACTIONS REFUSED (by reason code, verdict, rule)',
      ...refusalLines,
      '',
      `Net value across the batch: ${formatINR(totalNet)}.`,
      `${outcomes.length} attempts fired, ${refusals.length} actions refused.`,
    ].join('\n'),
    totalNet,
    decisions: outcomes.length + refusals.length,
  };
}

/**
 * The rule name from a refusal detail, discarding the row-specific numbers.
 *
 * "Only 0.1h since the last attempt; insufficient_funds requires 48h" and the same sentence
 * with 0.3h are the same finding. Grouping on the whole string would produce one row per
 * refusal and bury the pattern the agent is meant to notice.
 */
function ruleOf(detail: string): string {
  if (detail.includes('since the last attempt')) return 'min_gap';
  if (detail.includes('kill switch')) return 'kill_switch';
  if (detail.includes('permits no attempts')) return 'terminal';
  if (detail.includes('exceeds the schedule')) return 'attempt_cap';
  if (detail.includes('fee budget')) return 'fee_budget';
  if (detail.includes('below the policy floor')) return 'ev_floor';
  if (detail.includes('smaller than the cost')) return 'ev_negative';
  if (detail.includes('probability is zero')) return 'ev_zero_probability';
  return 'other';
}
