import { describe, expect, it } from 'vitest';
import type { ProposedChange } from '@rc/ai';
import { buildPolicy, loadPolicy } from '@rc/policy';
import { applyChanges } from './apply-policy.js';

/**
 * The YAML edit has to actually happen.
 *
 * If it silently did nothing, the held-out evaluation would compare a policy against itself,
 * report a delta of exactly zero, and be indistinguishable from an honest "this change does
 * not help". That is the worst failure available here, because it looks like rigour.
 */

const policy = loadPolicy();

function change(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    field: 'min_gap_hours',
    reason_code: 'do_not_honour',
    from_value: 24,
    to_value: 48,
    rationale: 'A rationale long enough to satisfy the schema minimum.',
    evidence_decision_ids: [],
    ...overrides,
  };
}

describe('applyChanges', () => {
  it('edits the named reason code and nothing else', () => {
    const next = buildPolicy(applyChanges(policy, [change({})]));

    expect(next.forReason('do_not_honour').min_gap_hours).toBe(48);
    // The neighbouring code's gap is a different number in the same file; a greedy or
    // unscoped pattern would take that one instead.
    expect(next.forReason('insufficient_funds').min_gap_hours).toBe(
      policy.forReason('insufficient_funds').min_gap_hours,
    );
  });

  it('edits the global expected-value floor', () => {
    const next = buildPolicy(
      applyChanges(policy, [
        change({ field: 'ev_floor_paise', reason_code: null, from_value: 500, to_value: 350 }),
      ]),
    );

    expect(Number(next.evFloor)).toBe(350);
  });

  it('increments the policy version', () => {
    const next = buildPolicy(applyChanges(policy, [change({})]));
    expect(next.version).toBe(policy.version + 1);
  });

  it('produces a policy that still loads and validates', () => {
    // The edit is textual, so a malformed replacement would produce YAML that parses but
    // fails schema validation — caught here rather than mid-evaluation.
    expect(() => buildPolicy(applyChanges(policy, [change({})]))).not.toThrow();
  });

  it('throws rather than silently doing nothing when the target is absent', () => {
    // The failure this module exists to prevent, on a real case rather than a synthetic
    // one: `suspected_fraud_block` has an empty schedule and therefore no `min_gap_hours`
    // line at all. Asking to change one must fail loudly, not return the text untouched and
    // let a held-out comparison report a confident zero.
    expect(() =>
      applyChanges(policy, [change({ reason_code: 'suspected_fraud_block', to_value: 72 })]),
    ).toThrow(/no matching line/);
  });

  it('never reaches into a class override to satisfy a change to the base entry', () => {
    // THE REGRESSION THAT MOTIVATED REWRITING THIS MODULE LINE-BY-LINE.
    //
    // `card_expired` has no `min_gap_hours` in its base block, and it has one in the
    // `subscription_failure` override. The previous regex was scoped to the code's block only
    // by the lazy quantifier stopping at the first match, so it ran past the end of the block
    // and silently rewrote the override — no error, wrong setting changed, and a held-out
    // comparison measuring the effect of a change nobody proposed.
    expect(() =>
      applyChanges(policy, [change({ reason_code: 'card_expired', to_value: 72 })]),
    ).toThrow(/no matching line/);

    // And the override is untouched, which is the half a passing throw does not prove.
    expect(policy.yaml).toContain('min_gap_hours: 24');
    expect(policy.forReason('card_expired', 'subscription_failure').min_gap_hours).toBe(24);
  });

  it('edits the named code and leaves every other block alone', () => {
    // The positive half: scoping correctly is only useful if the intended edit still lands.
    const applied = buildPolicy(
      applyChanges(policy, [change({ reason_code: 'insufficient_funds', to_value: 72 })]),
    );

    expect(applied.forReason('insufficient_funds').min_gap_hours).toBe(72);
    // `no_response` also carries a min_gap_hours, further down the same file.
    expect(applied.forReason('no_response').min_gap_hours).toBe(
      policy.forReason('no_response').min_gap_hours,
    );
    expect(applied.forReason('card_expired', 'subscription_failure').min_gap_hours).toBe(24);
  });

  it('warns nobody when a change is legal but inert — which is the harder problem', () => {
    // `do_not_honour` permits exactly one attempt, and `min_gap_hours` only binds from the
    // second onward. So this edit applies perfectly and changes nothing about behaviour.
    //
    // The agent proposed precisely this. The schema allowed it, the range check allowed it,
    // and it was right to: the value is in range and the field is tunable. Only the
    // held-out evaluation caught that it does nothing, which is exactly why an approved
    // change is measured before it is trusted.
    const next = buildPolicy(applyChanges(policy, [change({ to_value: 96 })]));

    expect(next.forReason('do_not_honour').min_gap_hours).toBe(96);
    expect(next.attemptCap('do_not_honour')).toBe(1);
  });

  it('applies several changes together', () => {
    const next = buildPolicy(
      applyChanges(policy, [
        change({}),
        change({ field: 'ev_floor_paise', reason_code: null, to_value: 750 }),
      ]),
    );

    expect(next.forReason('do_not_honour').min_gap_hours).toBe(48);
    expect(Number(next.evFloor)).toBe(750);
  });
});
