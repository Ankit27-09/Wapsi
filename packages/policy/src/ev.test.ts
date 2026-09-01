import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BPS_ONE,
  ZERO,
  add,
  bps,
  mulBps,
  paise,
  paiseFromRupeeString,
  sub,
  toRupeeString,
  type Bps,
  type Paise,
} from '@rc/core';
import { evGate, expected, type EvInput } from './ev.js';

/**
 * Properties of the expected-value gate.
 *
 * The gate decides whether money is spent, so its behaviour is asserted over generated
 * inputs rather than over a handful of examples. Each property below is a sentence someone
 * could challenge in a technical panel, expressed as something that either holds for
 * every input or fails the build.
 */

const anyAmount = fc.bigInt({ min: 1n, max: 50_000_000n }).map(paise);
const anyBpsValue = fc.integer({ min: 0, max: BPS_ONE }).map(bps);
const anyCost = fc.bigInt({ min: 0n, max: 100_000n }).map(paise);
const anyFloor = fc.bigInt({ min: 0n, max: 500_000n }).map(paise);

const anyInput: fc.Arbitrary<EvInput> = fc.record({
  amount: anyAmount,
  marginBps: anyBpsValue,
  pBps: anyBpsValue,
  gatewayFee: anyCost,
  messageCost: anyCost,
  llmCost: anyCost,
  floor: anyFloor,
});

describe('evGate — the verdict is exactly its definition', () => {
  it('passes if and only if the action can succeed AND net value reaches the floor', () => {
    // Both conjuncts matter, and the second alone is not the gate's contract. An earlier
    // version of this property omitted the probability clause and immediately found a
    // real gap: with `p = 0`, `cost = 0`, `floor = 0`, net is exactly zero, clears the
    // floor on a technicality, and a structurally impossible attempt fires.
    fc.assert(
      fc.property(anyInput, (input) => {
        const verdict = evGate(input);
        const shouldPass = input.pBps > 0 && verdict.arithmetic.net >= input.floor;
        expect(verdict.kind === 'pass').toBe(shouldPass);
      }),
    );
  });

  it('reports arithmetic that reconstructs exactly, on both verdicts', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const { arithmetic } = evGate(input);

        expect(arithmetic.value).toBe(mulBps(input.amount, input.marginBps));
        expect(arithmetic.cost).toBe(
          add(add(input.gatewayFee, input.messageCost), input.llmCost),
        );
        expect(arithmetic.net).toBe(sub(expected(arithmetic), arithmetic.cost));
        expect(arithmetic.pBps).toBe(input.pBps);
      }),
    );
  });

  it('stores four numbers, not five — expected recovery is derived', () => {
    // `expected()` is recomputed from `value` and `pBps` rather than stored, so there is
    // no fifth number that can drift out of agreement with the other four.
    fc.assert(
      fc.property(anyInput, (input) => {
        const { arithmetic } = evGate(input);
        expect(expected(arithmetic)).toBe(mulBps(arithmetic.value, arithmetic.pBps));
      }),
    );
  });
});

describe('evGate — structural refusals', () => {
  it('never fires when the success probability is zero', () => {
    // The single most expensive modelling error available on this problem would be
    // spending a fee against a probability of exactly zero: an expired card, a revoked
    // mandate. The gate must refuse those on arithmetic alone, without relying on the
    // schedule being configured correctly.
    fc.assert(
      fc.property(anyAmount, anyBpsValue, anyCost, anyFloor, (amount, marginBps, fee, floor) => {
        const verdict = evGate({
          amount,
          marginBps,
          pBps: bps(0),
          gatewayFee: fee,
          messageCost: ZERO,
          llmCost: ZERO,
          floor,
        });
        expect(verdict.kind).toBe('fail');
        expect(verdict.arithmetic.net).toBe(sub(ZERO, fee));
      }),
    );
  });

  it('refuses a zero-probability action even when it is free and the floor is zero', () => {
    // The exact counterexample the property above surfaced. Kept as a named regression
    // test, because the reasoning is not obvious from the property alone: net is zero,
    // zero clears a floor of zero, and nothing in the economics objects.
    const verdict = evGate({
      amount: paiseFromRupeeString('5000.00'),
      marginBps: bps(1800),
      pBps: bps(0),
      gatewayFee: ZERO,
      messageCost: ZERO,
      llmCost: ZERO,
      floor: ZERO,
    });

    expect(verdict.kind).toBe('fail');
    expect(verdict.arithmetic.net).toBe(ZERO);
    if (verdict.kind === 'fail') expect(verdict.detail).toMatch(/zero/i);
  });

  it('explains a zero-probability refusal differently from a marginal one', () => {
    const base = {
      amount: paiseFromRupeeString('5000.00'),
      marginBps: bps(1800),
      gatewayFee: paiseFromRupeeString('3.50'),
      messageCost: ZERO,
      llmCost: ZERO,
      floor: paiseFromRupeeString('5.00'),
    };

    const impossible = evGate({ ...base, pBps: bps(0) });
    const marginal = evGate({ ...base, pBps: bps(5) });

    expect(impossible.kind).toBe('fail');
    expect(marginal.kind).toBe('fail');
    if (impossible.kind !== 'fail' || marginal.kind !== 'fail') return;

    // An operator reading the exception queue needs to distinguish "this can never work"
    // from "this nearly worked" — they lead to completely different follow-up.
    expect(impossible.detail).toMatch(/zero/i);
    expect(marginal.detail).not.toMatch(/zero/i);
  });
});

describe('evGate — monotonicity', () => {
  it('never turns a pass into a fail when the probability rises', () => {
    fc.assert(
      fc.property(anyInput, anyBpsValue, (input, other) => {
        const [lo, hi] = input.pBps <= other ? [input.pBps, other] : [other, input.pBps];
        const low = evGate({ ...input, pBps: lo });
        const high = evGate({ ...input, pBps: hi });
        if (low.kind === 'pass') expect(high.kind).toBe('pass');
      }),
    );
  });

  it('never turns a pass into a fail when the amount rises', () => {
    fc.assert(
      fc.property(anyInput, anyAmount, (input, other) => {
        const [lo, hi] = input.amount <= other ? [input.amount, other] : [other, input.amount];
        const low = evGate({ ...input, amount: lo });
        const high = evGate({ ...input, amount: hi });
        if (low.kind === 'pass') expect(high.kind).toBe('pass');
      }),
    );
  });

  it('never turns a fail into a pass when cost rises', () => {
    fc.assert(
      fc.property(anyInput, anyCost, (input, extra) => {
        const dearer = evGate({ ...input, gatewayFee: add(input.gatewayFee, extra) });
        const cheaper = evGate(input);
        if (cheaper.kind === 'fail') expect(dearer.kind).toBe('fail');
      }),
    );
  });
});

describe('evGate — contribution margin, not gross amount', () => {
  it('refuses a large low-margin ticket that a gross-value gate would have fired', () => {
    // This is the case the design exists for, and the one that separates it from a gate
    // that multiplies by the transaction amount. A ₹4 lakh invoice at 0.5% margin with a
    // 4% chance of recovery is worth ₹80 in expectation — against a ₹3.50 fee it clears a
    // low floor, but on gross value it would look like a ₹16,000 opportunity.
    const input: EvInput = {
      amount: paiseFromRupeeString('400000.00'),
      marginBps: bps(50),
      pBps: bps(400),
      gatewayFee: paiseFromRupeeString('3.50'),
      messageCost: paiseFromRupeeString('0.18'),
      llmCost: paiseFromRupeeString('0.04'),
      floor: paiseFromRupeeString('100.00'),
    };

    const verdict = evGate(input);
    expect(verdict.kind).toBe('fail');
    expect(toRupeeString(expected(verdict.arithmetic))).toBe('80.00');

    // The same transaction at a realistic D2C margin clears comfortably.
    const highMargin = evGate({ ...input, marginBps: bps(2600) });
    expect(highMargin.kind).toBe('pass');
  });

  it('lets a small high-margin ticket through where a flat rule would not', () => {
    const verdict = evGate({
      amount: paiseFromRupeeString('499.00'),
      marginBps: bps(2600),
      pBps: bps(4500),
      gatewayFee: paiseFromRupeeString('0.80'),
      messageCost: ZERO,
      llmCost: paiseFromRupeeString('0.04'),
      floor: paiseFromRupeeString('5.00'),
    });

    // ₹499.00 × 26% = ₹129.74 → × 45% = ₹58.38 → − ₹0.80 fee − ₹0.04 model = ₹57.54
    expect(verdict.kind).toBe('pass');
    expect(toRupeeString(verdict.arithmetic.net)).toBe('57.54');
  });
});

describe('evGate — the money path has no floating point', () => {
  it('keeps every reported quantity a bigint', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const { arithmetic } = evGate(input);
        for (const quantity of [arithmetic.value, arithmetic.cost, arithmetic.net] satisfies Paise[]) {
          expect(typeof quantity).toBe('bigint');
        }
        // The probability is an integer too, not a unit float. That is the part which,
        // if it regressed, would silently reintroduce floats into every expected value.
        expect(Number.isInteger(arithmetic.pBps satisfies Bps as number)).toBe(true);
      }),
    );
  });
});
