import { describe, expect, it } from 'vitest';
import { createModelBudget } from './budget.js';
import { ZERO, paise } from './money.js';

/**
 * The model spend ceiling.
 *
 * The property that matters is not "it counts correctly" — it is that the check happens
 * BEFORE the call, so the call which would breach the cap never happens. A budget that
 * records an overspend and then stops is an audit trail of the thing it existed to prevent.
 */

const limits = { maxCalls: 3, maxCostPaise: paise(1000n) };

describe('the call ceiling', () => {
  it('permits exactly the configured number of calls and refuses the next', () => {
    const budget = createModelBudget({ maxCalls: 3, maxCostPaise: paise(1_000_000n) });

    for (let i = 0; i < 3; i += 1) {
      expect(budget.reserve().kind).toBe('ok');
      budget.settle(paise(10n));
    }

    const refused = budget.reserve();
    expect(refused.kind).toBe('breach');
    if (refused.kind === 'breach') {
      expect(refused.rule).toBe('call_ceiling');
      expect(refused.calls).toBe(3);
    }
  });

  it('refuses everything when the ceiling is zero', () => {
    // A configured zero must mean zero rather than one. The reserve-then-settle shape makes
    // it easy to write a counter that permits the first call unconditionally.
    const budget = createModelBudget({ maxCalls: 0, maxCostPaise: paise(1000n) });
    expect(budget.reserve().kind).toBe('breach');
    expect(budget.calls).toBe(0);
  });
});

describe('the cost ceiling', () => {
  it('refuses once spend has REACHED the cap, not once it has passed it', () => {
    // A ceiling, not a target. Refusing only after the total exceeds the cap would let the
    // cap be spent in full and then exceeded.
    const budget = createModelBudget(limits);

    budget.settle(paise(999n));
    expect(budget.reserve().kind).toBe('ok');

    budget.settle(paise(1n));
    const refused = budget.reserve();
    expect(refused.kind).toBe('breach');
    if (refused.kind === 'breach') expect(refused.rule).toBe('cost_ceiling');
  });

  it('bounds the overshoot to one call, and says so rather than pretending otherwise', () => {
    // AN HONEST LIMITATION, asserted so it stays true. The cost of a call is known only once
    // it returns, so the last permitted call can take the total past the cap. What must NOT
    // happen is a second call after that.
    const budget = createModelBudget({ maxCalls: 100, maxCostPaise: paise(1000n) });

    expect(budget.reserve().kind).toBe('ok');
    budget.settle(paise(5000n)); // one very expensive call, far past the ceiling

    expect(budget.spent).toBe(paise(5000n));
    expect(budget.reserve().kind).toBe('breach');
    // Exactly one call happened, and it is the overshoot the design accepts.
    expect(budget.calls).toBe(1);
  });

  it('reports the breach in rupees, because a paise figure is unreadable at a glance', () => {
    const budget = createModelBudget({ maxCalls: 10, maxCostPaise: paise(200_000n) });
    budget.settle(paise(200_000n));

    const refused = budget.reserve();
    if (refused.kind !== 'breach') throw new Error('expected a breach');
    expect(refused.detail).toContain('₹2,000.00');
  });
});

describe('whichever ceiling binds first', () => {
  it('names the call ceiling when calls run out before the money does', () => {
    const budget = createModelBudget({ maxCalls: 2, maxCostPaise: paise(1_000_000n) });
    budget.settle(paise(1n));
    budget.settle(paise(1n));

    const refused = budget.reserve();
    if (refused.kind !== 'breach') throw new Error('expected a breach');
    expect(refused.rule).toBe('call_ceiling');
  });

  it('names the cost ceiling when the money runs out before the calls do', () => {
    const budget = createModelBudget({ maxCalls: 1000, maxCostPaise: paise(50n) });
    budget.settle(paise(50n));

    const refused = budget.reserve();
    if (refused.kind !== 'breach') throw new Error('expected a breach');
    expect(refused.rule).toBe('cost_ceiling');
  });
});

describe('bookkeeping', () => {
  it('starts at zero and only advances on settle', () => {
    const budget = createModelBudget(limits);
    expect(budget.calls).toBe(0);
    expect(budget.spent).toBe(ZERO);

    // Reserving is not spending. A reservation that incremented the counter would charge for
    // calls that were refused.
    budget.reserve();
    budget.reserve();
    expect(budget.calls).toBe(0);

    budget.settle(paise(7n));
    expect(budget.calls).toBe(1);
    expect(budget.spent).toBe(paise(7n));
  });

  it('refuses a negative or fractional call ceiling at construction', () => {
    expect(() => createModelBudget({ maxCalls: -1, maxCostPaise: paise(1n) })).toThrow(
      /non-negative integer/,
    );
    expect(() => createModelBudget({ maxCalls: 1.5, maxCostPaise: paise(1n) })).toThrow(
      /non-negative integer/,
    );
  });

  it('exhausted() agrees with reserve()', () => {
    const budget = createModelBudget({ maxCalls: 1, maxCostPaise: paise(1000n) });
    expect(budget.exhausted()).toBe(false);
    budget.settle(paise(1n));
    expect(budget.exhausted()).toBe(true);
  });
});
