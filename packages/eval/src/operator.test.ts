import { describe, expect, it } from 'vitest';
import { authorise } from './operator.js';

/**
 * The operator gate.
 *
 * What is asserted here is mostly the set of values that must NOT authorise. A gate that
 * accepts the right token is easy; a gate that also accepts the placeholder from
 * `.env.example`, or an empty string, or a four-character secret, is a formality that reads
 * like a control — which is worse than no gate at all, because the audit row then claims a
 * human decided and cannot establish it.
 */

const REAL = 'a-real-operator-secret-value';

const env = (token?: string): NodeJS.ProcessEnv =>
  token === undefined ? {} : { OPERATOR_TOKEN: token };

describe('what authorises', () => {
  it('accepts the configured token', () => {
    const result = authorise({ presented: REAL, operator: 'human:ankit', env: env(REAL) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.operator).toBe('human:ankit');
  });
});

describe('what must not authorise', () => {
  it('refuses when OPERATOR_TOKEN is unset', () => {
    // The state the repository was actually in: the variable documented, read by nothing.
    const result = authorise({ presented: 'anything', operator: 'human:x', env: env() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/not set/);
  });

  it('refuses the placeholder from .env.example', () => {
    // `change-me-locally` is published in this repository. Authenticating against it
    // establishes nothing, so it must fail rather than warn — the same reasoning that makes
    // a live Razorpay key unrepresentable rather than discouraged.
    const result = authorise({
      presented: 'change-me-locally',
      operator: 'human:x',
      env: env('change-me-locally'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/placeholder/);
  });

  it('refuses a secret short enough to guess', () => {
    const result = authorise({ presented: 'short', operator: 'human:x', env: env('short') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/16/);
  });

  it('refuses when no token is presented', () => {
    const result = authorise({ presented: undefined, operator: 'human:x', env: env(REAL) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/No --token/);
  });

  it('refuses an empty presented token', () => {
    const result = authorise({ presented: '', operator: 'human:x', env: env(REAL) });
    expect(result.ok).toBe(false);
  });

  it('refuses a wrong token', () => {
    const result = authorise({ presented: 'wrong-but-long-enough', operator: 'human:x', env: env(REAL) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/does not match/);
  });

  it('refuses a correct token with no operator named', () => {
    // An anonymous approval in the audit trail defeats the purpose of having one. The point
    // is not only that somebody was authorised, but that the trail says who.
    const result = authorise({ presented: REAL, operator: '   ', env: env(REAL) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/anonymous/);
  });
});

describe('comparison does not leak the secret through length or prefix', () => {
  it('rejects a correct prefix as firmly as a wrong first character', () => {
    // Both must fail identically. The implementation hashes both sides to a fixed width and
    // compares the digests with `timingSafeEqual`, so neither the length nor the length of
    // the common prefix is observable from how long the comparison takes.
    const prefix = authorise({
      presented: REAL.slice(0, REAL.length - 1),
      operator: 'human:x',
      env: env(REAL),
    });
    const wrong = authorise({
      presented: `Z${REAL.slice(1)}`,
      operator: 'human:x',
      env: env(REAL),
    });

    expect(prefix.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (!prefix.ok && !wrong.ok) expect(prefix.problem).toBe(wrong.problem);
  });

  it('handles a presented token of a wildly different length without throwing', () => {
    // `timingSafeEqual` throws on buffers of differing length, which is why both sides are
    // hashed first. A gate that threw here would be a denial-of-service on itself.
    expect(() =>
      authorise({ presented: 'x'.repeat(5000), operator: 'human:x', env: env(REAL) }),
    ).not.toThrow();
  });
});
