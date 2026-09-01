import { ZERO, paise, type Paise } from '@rc/core';

/**
 * MODEL COST, IN PAISE
 *
 * Every rupee the model spends lands in the cost line of net value. Excluding it would
 * make the headline figure flatter the AI by exactly the amount the AI costs, which is the
 * one direction the number must not be wrong in.
 *
 * Integer arithmetic, like the rest of the money path. Prices are converted once into
 * paise-per-million-tokens (an integer), and per-call cost is then a bigint multiply and
 * divide — no float touches a figure that reaches the report.
 *
 * Published per-token prices, USD per million tokens (Anthropic first-party rates):
 *
 *   claude-opus-5     $5 in  / $25 out
 *   claude-sonnet-5   $2 in  / $10 out
 *   claude-haiku-4-5  $1 in  / $5  out
 *
 * Cache reads bill at roughly 0.1× the input rate and cache writes at roughly 1.25×.
 * Both are applied below, because a cost model that ignored caching would overstate spend
 * by an order of magnitude on the classification path — where the taxonomy prefix is
 * identical on every call in a batch and is exactly what caching exists for.
 */

interface Price {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  'claude-fable-5': { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  'claude-sonnet-5': { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  'claude-haiku-4-5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
};

/** Cache reads bill at a tenth of the input rate. Expressed as basis points of it. */
const CACHE_READ_BPS = 1_000;
/** Cache writes bill at 1.25× the input rate. */
const CACHE_WRITE_BPS = 12_500;

const MILLION = 1_000_000n;
const BPS_ONE = 10_000n;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * Cost of one model call.
 *
 * `usdInrPaise` is an explicit argument rather than a constant, because it is an
 * assumption and assumptions in this project are stated where they are used. Every model
 * cost in the report scales linearly with it.
 */
export function modelCallCost(
  model: string,
  usage: TokenUsage,
  usdInrPaise: number,
): Paise {
  const price = PRICES[model];
  if (price === undefined) {
    // Refusing beats guessing. A silently zero-cost model call would understate spend and
    // overstate net value — and it would do so invisibly, because nothing else in the
    // system knows what a model call ought to cost.
    throw new Error(
      `No published price for model "${model}". Add it to PRICES in @rc/ai/cost.ts ` +
        `rather than letting its calls cost nothing.`,
    );
  }

  // Paise per million tokens, as integers. Converted once, here, so per-call arithmetic
  // stays exact.
  const inputPaisePerMTok = BigInt(Math.round(price.inputUsdPerMTok * usdInrPaise));
  const outputPaisePerMTok = BigInt(Math.round(price.outputUsdPerMTok * usdInrPaise));

  const uncached = (BigInt(usage.inputTokens) * inputPaisePerMTok) / MILLION;
  const output = (BigInt(usage.outputTokens) * outputPaisePerMTok) / MILLION;

  const cacheRead =
    (BigInt(usage.cacheReadTokens) * inputPaisePerMTok * BigInt(CACHE_READ_BPS)) /
    (MILLION * BPS_ONE);

  const cacheWrite =
    (BigInt(usage.cacheWriteTokens) * inputPaisePerMTok * BigInt(CACHE_WRITE_BPS)) /
    (MILLION * BPS_ONE);

  return paise(uncached + output + cacheRead + cacheWrite);
}

export const NO_COST = ZERO;

/** Models this cost model can price. Exported so a misconfiguration fails at boot. */
export function isPricedModel(model: string): boolean {
  return model in PRICES;
}
