import { z } from 'zod';
import type { Brand } from './brand.js';

/**
 * MONEY, AND WHY THERE IS NO FLOATING POINT ANYWHERE IN THIS FILE
 * ================================================================
 *
 * Every monetary quantity in this system is an integer count of paise, carried as a
 * `bigint` and branded `Paise` so it cannot be confused with a plain number. There is
 * no constructor that accepts a JavaScript `number`, because `number` is a float and a
 * float will not tie. On a 300-record batch, accumulated representation error is not
 * theoretical — it shows up as a total that is three paise off, on stage, in front of
 * people who reconcile ledgers for a living.
 *
 * The less obvious half: PROBABILITIES ARE ALSO INTEGERS.
 *
 * A recovery decision multiplies an amount by a contribution margin and by a success
 * probability. If the probability is a float, the float re-enters the money path
 * through the back door and the guarantee above is worthless. So probabilities and
 * margins are both carried as integer basis points (`Bps`, 1 bps = 0.01%), and the
 * expected-value computation is integer arithmetic end to end:
 *
 *     ev = mulBps(mulBps(amount, marginBps), pBps) - cost
 *
 * There is no `number` in that expression. Model confidence arrives from the LLM as a
 * float and is converted to `Bps` at the validation boundary — and confidence is a
 * *routing* decision (act, or send to the exception queue), never a money one.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An exact, signed count of paise. 100 paise = ₹1. */
export type Paise = Brand<bigint, 'Paise'>;

/** Integer basis points. 10_000 bps = 100% = 1.0. */
export type Bps = Brand<number, 'Bps'>;

/** One whole unit, in basis points. */
export const BPS_ONE = 10_000;

const BPS_ONE_BIG = 10_000n;
const BPS_HALF_BIG = 5_000n;

// ---------------------------------------------------------------------------
// Construction — the only ways to make money
// ---------------------------------------------------------------------------

/** Wrap a `bigint` count of paise. The primitive constructor. */
export function paise(value: bigint): Paise {
  return value as Paise;
}

/**
 * Parse an exact integer string of paise, e.g. `"48721344"`.
 * Used at the database and JSON boundaries, where `bigint` does not survive transit.
 */
export function paiseFromString(value: string): Paise {
  if (!/^-?\d+$/.test(value)) {
    throw new RangeError(`Not an integer paise string: ${JSON.stringify(value)}`);
  }
  return BigInt(value) as Paise;
}

/**
 * Parse a decimal rupee string with at most two places, e.g. `"4872.13"` → 487213 paise.
 *
 * Exact: the fractional part is parsed as digits, never as a float. This is the only
 * place rupee-denominated input is accepted, and it exists because human-authored
 * fixtures and citation tables are written in rupees.
 */
export function paiseFromRupeeString(value: string): Paise {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) {
    throw new RangeError(
      `Not a rupee amount with at most two decimal places: ${JSON.stringify(value)}`,
    );
  }
  const [, sign, whole, frac = ''] = match;
  const paisePart = frac.padEnd(2, '0');
  const magnitude = BigInt(whole ?? '0') * 100n + BigInt(paisePart);
  return (sign === '-' ? -magnitude : magnitude) as Paise;
}

export const ZERO = paise(0n);

/** Construct integer basis points. Rejects non-integers and negatives. */
export function bps(value: number): Bps {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`Basis points must be a non-negative integer, got ${value}`);
  }
  return value as Bps;
}

/**
 * Convert a unit probability or confidence in [0, 1] to basis points.
 *
 * The one sanctioned float → integer crossing, placed here so it is greppable. Callers
 * are model-output boundaries only: an LLM returns `0.71`, and it becomes `7100` bps
 * before it is allowed anywhere near a decision. Rounds half-up.
 */
export function bpsFromUnit(value: number): Bps {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`Unit probability must be within [0, 1], got ${value}`);
  }
  return Math.round(value * BPS_ONE) as Bps;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function add(a: Paise, b: Paise): Paise {
  return (a + b) as Paise;
}

export function sub(a: Paise, b: Paise): Paise {
  return (a - b) as Paise;
}

// Negation is written as subtraction from zero rather than unary minus. Unary minus on
// a branded bigint needs a cast to stay branded, and a cast is the thing this module
// exists to avoid — `sub` already carries the guarantee.
export function neg(a: Paise): Paise {
  return sub(ZERO, a);
}

export function sum(values: readonly Paise[]): Paise {
  let total = 0n;
  for (const value of values) total += value;
  return total as Paise;
}

/**
 * Scale by basis points, rounding half away from zero.
 *
 * Rounding is stated rather than inherited: half-away-from-zero is symmetric, so a
 * credit and an equal debit round to equal magnitudes and a batch of offsetting
 * entries still ties. A property test in `money.test.ts` asserts that invariant.
 */
export function mulBps(amount: Paise, rate: Bps): Paise {
  const scaled = amount * BigInt(rate);
  const rounded =
    scaled >= 0n
      ? (scaled + BPS_HALF_BIG) / BPS_ONE_BIG
      : -((-scaled + BPS_HALF_BIG) / BPS_ONE_BIG);
  return rounded as Paise;
}

export function min(a: Paise, b: Paise): Paise {
  return a <= b ? a : b;
}

export function max(a: Paise, b: Paise): Paise {
  return a >= b ? a : b;
}

/** Standard three-way comparison, for sorting without float coercion. */
export function cmp(a: Paise, b: Paise): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isNegative(a: Paise): boolean {
  return a < 0n;
}

export function gte(a: Paise, b: Paise): boolean {
  return a >= b;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Exact decimal rupee string, e.g. `-487213` → `"-4872.13"`. Never lossy. */
export function toRupeeString(value: Paise): string {
  const negative = value < 0n;
  const magnitude: bigint = negative ? 0n - value : value;
  const whole = magnitude / 100n;
  const frac = magnitude % 100n;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
}

/**
 * Indian-grouped display string, e.g. `"₹4,87,213.44"`.
 *
 * Lakh/crore grouping rather than thousands — this is an Indian payments product and a
 * Western-grouped figure reads as foreign to the audience. Built from the exact decimal
 * string above, so formatting never touches a float.
 */
export function formatINR(value: Paise, options?: { readonly symbol?: boolean }): string {
  const showSymbol = options?.symbol ?? true;
  const decimal = toRupeeString(value);
  const negative = decimal.startsWith('-');
  const [whole = '0', frac = '00'] = (negative ? decimal.slice(1) : decimal).split('.');

  // Last three digits stay together; everything to their left groups in pairs.
  const tail = whole.slice(-3);
  const head = whole.slice(0, -3);
  const grouped =
    head === '' ? tail : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;

  return `${negative ? '-' : ''}${showSymbol ? '₹' : ''}${grouped}.${frac}`;
}

/** Basis points as a human percentage string, e.g. `7100` → `"71.00%"`. */
export function formatBps(value: Bps): string {
  const whole = Math.trunc(value / 100);
  const frac = Math.abs(value % 100);
  return `${whole}.${frac.toString().padStart(2, '0')}%`;
}

// ---------------------------------------------------------------------------
// Zod schemas — the boundary between the outside world and the money path
// ---------------------------------------------------------------------------

/**
 * Paise arriving from outside: Postgres, JSON, or a human-authored YAML config.
 *
 * Three accepted forms, each for a real reason:
 *
 *   `bigint` — the native form, when the value never left the process.
 *   `string` — how `pg` returns `BIGINT` columns, and the only form that survives
 *              `JSON.stringify`. Both facts are load-bearing.
 *   `number` — how YAML and JSON parse `500`. Accepted only after `.int().safe()`,
 *              and those two checks are the whole guarantee: a float such as `500.5`
 *              is REJECTED here, so accepting numbers does not open a door for
 *              floating-point money. It only spares every amount in every config file
 *              from being written as a quoted string.
 *
 * This is the one door through which external values become money.
 */
export const PaiseSchema = z
  .union([
    // The shape is validated here rather than left to the transform below. A transform
    // that throws escapes `safeParse`, so a caller asking "is this valid?" would get an
    // exception instead of an answer — which is exactly the wrong behaviour at a
    // boundary whose whole job is to decide what is admissible.
    z.string().regex(/^-?\d+$/, 'Expected an integer paise string, e.g. "487213"'),
    z.bigint(),
    z.number().int().safe(),
  ])
  .transform((value): Paise => {
    if (typeof value === 'bigint') return paise(value);
    if (typeof value === 'number') return paise(BigInt(value));
    return paiseFromString(value);
  });

export const BpsSchema = z.number().int().min(0).max(BPS_ONE).transform((v): Bps => bps(v));

/** Model confidence as returned by an LLM: a unit float, converted immediately. */
export const ConfidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .transform((v): Bps => bpsFromUnit(v));
