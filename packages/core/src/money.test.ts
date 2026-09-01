import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BPS_ONE,
  PaiseSchema,
  ZERO,
  add,
  bps,
  bpsFromUnit,
  formatINR,
  mulBps,
  neg,
  paise,
  paiseFromRupeeString,
  paiseFromString,
  sub,
  sum,
  toRupeeString,
} from './money.js';

/**
 * Property tests on money.
 *
 * These are the cheapest disproportionately credible artefact in the repository. Each
 * one encodes an invariant that, if it broke, would produce a batch total that does not
 * tie — and a total that does not tie is visible on stage.
 */

// Ranges written as literals rather than exponentiation: esbuild declines to transform
// `**` on BigInt operands, and the bounds are clearer spelled out anyway.
// ±10^14 paise is ±₹10,000 crore — comfortably past any realistic batch.
const anyPaise = fc.bigInt({ min: -100_000_000_000_000n, max: 100_000_000_000_000n }).map(paise);
const positivePaise = fc.bigInt({ min: 1n, max: 1_000_000_000_000n }).map(paise);
const anyBps = fc.integer({ min: 0, max: BPS_ONE }).map(bps);

describe('money — construction', () => {
  it('rejects anything that is not an exact integer paise string', () => {
    for (const bad of ['1.5', '', 'x', '1e3', ' 12', '12 ', '0x10']) {
      expect(() => paiseFromString(bad)).toThrow(RangeError);
    }
  });

  it('parses rupee strings exactly, without ever touching a float', () => {
    expect(paiseFromRupeeString('4872.13')).toBe(487213n);
    expect(paiseFromRupeeString('0.07')).toBe(7n);
    expect(paiseFromRupeeString('0.1')).toBe(10n);
    expect(paiseFromRupeeString('-12.99')).toBe(-1299n);
    expect(paiseFromRupeeString('100')).toBe(10000n);
  });

  it('rejects rupee input with sub-paise precision rather than silently rounding it', () => {
    // 0.005 is representable as a wish and not as money. Refusing it here is why a
    // batch total ties: there is no path by which a third decimal place enters.
    expect(() => paiseFromRupeeString('12.345')).toThrow(RangeError);
  });

  it('round-trips through the decimal string form for any value', () => {
    fc.assert(
      fc.property(anyPaise, (value) => {
        expect(paiseFromRupeeString(toRupeeString(value))).toBe(value);
      }),
    );
  });
});

describe('money — arithmetic invariants', () => {
  it('sums tie regardless of association or order', () => {
    fc.assert(
      fc.property(fc.array(anyPaise, { maxLength: 400 }), (values) => {
        const viaSum = sum(values);
        const viaFold = values.reduce(add, ZERO);
        const viaReversed = [...values].reverse().reduce(add, ZERO);
        expect(viaSum).toBe(viaFold);
        expect(viaSum).toBe(viaReversed);
      }),
    );
  });

  it('add and sub are exact inverses — no accumulated drift', () => {
    fc.assert(
      fc.property(anyPaise, anyPaise, (a, b) => {
        expect(sub(add(a, b), b)).toBe(a);
      }),
    );
  });

  it('scaling by 100% is the identity', () => {
    fc.assert(
      fc.property(anyPaise, (value) => {
        expect(mulBps(value, bps(BPS_ONE))).toBe(value);
      }),
    );
  });

  it('scaling by 0% is zero', () => {
    fc.assert(
      fc.property(anyPaise, (value) => {
        expect(mulBps(value, bps(0))).toBe(ZERO);
      }),
    );
  });

  it('scaling is monotonic in the rate for positive amounts', () => {
    fc.assert(
      fc.property(positivePaise, anyBps, anyBps, (amount, x, y) => {
        const [lo, hi] = x <= y ? [x, y] : [y, x];
        expect(mulBps(amount, lo) <= mulBps(amount, hi)).toBe(true);
      }),
    );
  });

  it('rounds symmetrically about zero, so offsetting entries still tie', () => {
    // The reason `mulBps` rounds half-away-from-zero rather than half-up: a credit and
    // an equal debit must round to equal magnitudes, or a batch containing both fails
    // to reconcile by one paise per pair.
    fc.assert(
      fc.property(anyPaise, anyBps, (value, rate) => {
        expect(mulBps(neg(value), rate)).toBe(neg(mulBps(value, rate)));
      }),
    );
  });

  it('never loses more than half a paise to rounding', () => {
    fc.assert(
      fc.property(positivePaise, anyBps, (amount, rate) => {
        const exactNumerator = amount * BigInt(rate);
        const rounded = mulBps(amount, rate) * 10_000n;
        const error = rounded - exactNumerator;
        expect(error <= 5_000n && error >= -5_000n).toBe(true);
      }),
    );
  });
});

describe('money — expected value is integer arithmetic end to end', () => {
  it('composes margin and probability without a float appearing', () => {
    // The exact shape of the EV gate: amount → margin → probability, then minus cost.
    // Written out here so that a regression which reintroduces float maths fails a test
    // rather than quietly changing a headline number.
    const amount = paiseFromRupeeString('4872.13');
    const margin = bps(1800); // 18% contribution margin
    const probability = bps(4500); // 45% modelled success
    const cost = paiseFromRupeeString('3.50');

    const value = mulBps(amount, margin); //  487213 × 18% =  87698 paise
    const expected = mulBps(value, probability); //   87698 × 45% =  39464 paise
    const net = sub(expected, cost); //   39464 −  350 =  39114 paise

    expect(typeof value).toBe('bigint');
    expect(typeof expected).toBe('bigint');
    expect(toRupeeString(net)).toBe('391.14');
  });

  it('converts model confidence at the boundary and nowhere else', () => {
    expect(bpsFromUnit(0.71)).toBe(7100);
    expect(bpsFromUnit(0)).toBe(0);
    expect(bpsFromUnit(1)).toBe(BPS_ONE);
    expect(() => bpsFromUnit(1.01)).toThrow(RangeError);
    expect(() => bpsFromUnit(Number.NaN)).toThrow(RangeError);
  });
});

describe('money — the external boundary', () => {
  it('accepts the three forms an amount arrives in, and rejects a float', () => {
    expect(PaiseSchema.parse(487213n)).toBe(487213n);
    expect(PaiseSchema.parse('487213')).toBe(487213n); // pg returns BIGINT as a string
    expect(PaiseSchema.parse(500)).toBe(500n); // YAML parses `500` as a number

    // The two checks that make accepting numbers safe. Without `.int()`, a float would
    // become money here and every guarantee downstream would be decoration.
    expect(PaiseSchema.safeParse(500.5).success).toBe(false);
    expect(PaiseSchema.safeParse(Number.MAX_VALUE).success).toBe(false);
    expect(PaiseSchema.safeParse(Number.NaN).success).toBe(false);
    expect(PaiseSchema.safeParse('12.34').success).toBe(false);
  });
});

describe('money — presentation', () => {
  it('groups in lakhs and crores, not thousands', () => {
    expect(formatINR(paiseFromRupeeString('4872.13'))).toBe('₹4,872.13');
    expect(formatINR(paiseFromRupeeString('487213.44'))).toBe('₹4,87,213.44');
    expect(formatINR(paiseFromRupeeString('12487213.00'))).toBe('₹1,24,87,213.00');
    expect(formatINR(paiseFromRupeeString('-1299.50'))).toBe('-₹1,299.50');
    expect(formatINR(ZERO)).toBe('₹0.00');
  });

  it('always shows exactly two decimal places', () => {
    fc.assert(
      fc.property(anyPaise, (value) => {
        expect(formatINR(value, { symbol: false })).toMatch(/^-?[\d,]+\.\d{2}$/);
      }),
    );
  });
});
