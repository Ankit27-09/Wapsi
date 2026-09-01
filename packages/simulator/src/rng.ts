import { BPS_ONE, type Bps } from '@rc/core';

/**
 * A seeded, deterministic pseudo-random generator.
 *
 * `Math.random()` is banned everywhere in this repository, and this is why: the README
 * claims that a clean clone plus three commands reproduces the numbers in the results
 * table. One unseeded call anywhere in the generation or simulation path makes that claim
 * false, and the claim is a large part of what the submission is offering.
 *
 * mulberry32: a 32-bit generator, chosen because it is short enough to audit in one
 * sitting, has no platform-dependent behaviour, and produces identical sequences on
 * every machine. It is not cryptographically secure and does not need to be — nothing
 * here is a secret, it is a die roll with a paper trail.
 *
 * The public surface is integer-only. `chance()` compares integers rather than floats,
 * so a probability never becomes a float even in the simulator — the same discipline the
 * money path follows, for the same reason: a float here would make the sequence depend
 * on rounding behaviour rather than only on the seed.
 */
export interface Rng {
  /** Uniform 32-bit unsigned integer. */
  nextU32(): number;
  /** Uniform integer in `[min, max]`, inclusive. */
  nextInt(min: number, max: number): number;
  /** True with probability `p` expressed in basis points. Pure integer comparison. */
  chance(p: Bps): boolean;
  /** Uniform element. Throws on an empty array rather than returning undefined. */
  pick<T>(items: readonly T[]): T;
  /** Element chosen by integer weight. Throws if all weights are zero. */
  weighted<T>(items: readonly { readonly item: T; readonly weight: number }[]): T;
  /** Fisher-Yates on a copy. The input is never mutated. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new RangeError(`Seed must be a non-negative integer, got ${seed}`);
  }

  // The generator's entire state: one 32-bit word.
  let state = seed >>> 0;

  const nextU32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  const nextInt = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError(`nextInt bounds must be integers, got ${min}..${max}`);
    }
    if (max < min) throw new RangeError(`nextInt called with max < min (${min}..${max})`);

    const span = max - min + 1;

    // Rejection sampling rather than a modulo. A plain `% span` biases the low end of
    // the range whenever span does not divide 2^32 — small, but it would be a bias
    // baked into every reported figure, and it costs one loop to remove.
    const limit = Math.floor(0x1_0000_0000 / span) * span;
    let draw = nextU32();
    while (draw >= limit) draw = nextU32();
    return min + (draw % span);
  };

  const chance = (p: Bps): boolean => {
    if (p <= 0) return false;
    if (p >= BPS_ONE) return true;
    return nextInt(1, BPS_ONE) <= p;
  };

  const pick = <T,>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError('pick called on an empty array');
    // Non-null assertion avoided: noUncheckedIndexedAccess makes the index optional, and
    // the length check above is the proof. An explicit throw documents the invariant.
    const chosen = items[nextInt(0, items.length - 1)];
    if (chosen === undefined) throw new Error('unreachable: index within bounds');
    return chosen;
  };

  const weighted = <T,>(items: readonly { readonly item: T; readonly weight: number }[]): T => {
    let total = 0;
    for (const entry of items) {
      if (!Number.isInteger(entry.weight) || entry.weight < 0) {
        throw new RangeError(`Weights must be non-negative integers, got ${entry.weight}`);
      }
      total += entry.weight;
    }
    if (total === 0) throw new RangeError('weighted called with all-zero weights');

    let roll = nextInt(1, total);
    for (const entry of items) {
      roll -= entry.weight;
      if (roll <= 0) return entry.item;
    }
    throw new Error('unreachable: weighted roll exceeded total');
  };

  const shuffle = <T,>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = nextInt(0, i);
      const a = copy[i];
      const b = copy[j];
      if (a === undefined || b === undefined) throw new Error('unreachable: bounded swap');
      copy[i] = b;
      copy[j] = a;
    }
    return copy;
  };

  return { nextU32, nextInt, chance, pick, weighted, shuffle };
}

/**
 * A named sub-stream derived from a parent seed.
 *
 * Without this, adding one extra draw anywhere early in generation shifts every
 * subsequent draw and the whole dataset changes — which makes "same seed, same numbers"
 * true but useless, because any code change to one stage reshuffles the others. Deriving
 * an independent stream per concern keeps stages isolated: changing how failure strings
 * are chosen cannot alter which amounts were generated.
 */
export function deriveRng(seed: number, stream: string): Rng {
  let hash = 0x811c9dc5;
  for (let i = 0; i < stream.length; i += 1) {
    hash ^= stream.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return createRng((seed ^ hash) >>> 0);
}
