import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { BPS_ONE } from '@rc/core';
import type { Rng } from './rng.js';
import { buildTruthModel, type TruthModel } from './truth.js';

/**
 * PERTURBING THE WORLD
 *
 * WHICH TABLE TO PERTURB, because the choice decides what the sweep actually proves.
 *
 * There are two prior tables. `priors.published.yaml` is what the policy believes;
 * `priors.truth.yaml` is what the world does. Perturbing the published priors would ask
 * "is the result robust to the policy being differently wrong?" — a mildly interesting
 * question. Perturbing the TRUTH asks "does the conclusion survive the world not being what
 * I invented?", and that is the question a panel is actually asking when they point out
 * that the author of the simulator is also the author of the policy.
 *
 * So this perturbs the truth. It is the harder test and the honest one.
 *
 * WHY ±60% RATHER THAN ±40%. The published priors carry a `source` per row and get the
 * narrower band where they are cited. The truth table carries no citations at all — every
 * figure in it is my invention, chosen to be plausible. Giving it the narrow band would be
 * claiming a confidence that nothing supports. The widest band is the honest one for a
 * table with no evidence behind it.
 *
 * The per-row draws are INDEPENDENT. Scaling every probability by one shared factor would
 * mostly move all arms together and understate the risk; independent draws break the
 * relationships between causes, which is where a strategy that has quietly overfitted to
 * one particular shape of world falls over.
 */

const TRUTH_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'priors.truth.yaml');

interface RawTruthRow {
  reason_code: string;
  attempt: number;
  timing: string;
  p_bps: number;
}

interface RawTruthFile {
  version: number;
  issuers: unknown[];
  structural_zeros: unknown[];
  truth: RawTruthRow[];
}

/** Parsed once. Re-reading the file 500 times would dominate the sweep's runtime. */
let cached: RawTruthFile | undefined;

function rawTruth(): RawTruthFile {
  cached ??= parse(readFileSync(TRUTH_PATH, 'utf8')) as RawTruthFile;
  return cached;
}

export interface PerturbOptions {
  /** Maximum relative change per row, in percent. */
  readonly bandPct: number;
}

/**
 * A world drawn from the neighbourhood of the shipped truth table.
 *
 * Structural zeros are NOT perturbed, and that is not an oversight. An expired card is not
 * "unlikely to recover", it is impossible — there is nothing to debit. Letting the sweep
 * hand it a 4% success rate would test the policy against a world that cannot exist, and
 * would flatter every arm that retries indiscriminately.
 */
export function perturbedTruth(rng: Rng, options: PerturbOptions): TruthModel {
  const base = rawTruth();
  const band = options.bandPct;

  const perturbed = base.truth.map((row) => {
    // Uniform in [-band, +band] percent, drawn per row.
    const deltaPct = rng.nextInt(-band, band);
    const scaled = Math.round((row.p_bps * (100 + deltaPct)) / 100);
    return { ...row, p_bps: Math.min(BPS_ONE, Math.max(0, scaled)) };
  });

  return buildTruthModel({ ...base, truth: perturbed });
}

export interface TruthOverride {
  readonly reasonCode: string;
  readonly attempt: number;
  readonly timing: string;
  readonly pBps: number;
}

/**
 * A world with named assumptions forced to specific values.
 *
 * Two uses, and they ask different questions.
 *
 * The THRESHOLD sweep walks a single load-bearing figure across its range to find where the
 * conclusion breaks. "It fails below 1.4x" is more useful to a panel than a percentage,
 * because it names what to go and measure first with real data.
 *
 * The HOSTILE worlds force a whole assumption to be systematically false at once. That is
 * the sharper test: the Monte Carlo sweep perturbs each row independently, so noise largely
 * averages out across a few hundred transactions and the conclusion survives almost by
 * construction. A world where the salary window simply does not work is not noise — it is
 * the strategy's premise being wrong, and nothing averages that away.
 */
export function truthWithOverrides(overrides: readonly TruthOverride[]): TruthModel {
  const base = rawTruth();

  const truth = base.truth.map((row) => {
    const override = overrides.find(
      (candidate) =>
        candidate.reasonCode === row.reason_code &&
        candidate.attempt === row.attempt &&
        candidate.timing === row.timing,
    );
    return override === undefined ? row : { ...row, p_bps: override.pBps };
  });

  return buildTruthModel({ ...base, truth });
}

/** Single-row convenience for the threshold sweep. */
export function truthWithOverride(override: TruthOverride): TruthModel {
  return truthWithOverrides([override]);
}

/** The shipped value of one truth row, for expressing an override as a multiple of it. */
export function baselineTruthValue(spec: {
  readonly reasonCode: string;
  readonly attempt: number;
  readonly timing: string;
}): number {
  const row = rawTruth().truth.find(
    (candidate) =>
      candidate.reason_code === spec.reasonCode &&
      candidate.attempt === spec.attempt &&
      candidate.timing === spec.timing,
  );

  if (row === undefined) {
    throw new Error(
      `No truth row for ${spec.reasonCode} attempt ${spec.attempt} at ${spec.timing}`,
    );
  }
  return row.p_bps;
}
