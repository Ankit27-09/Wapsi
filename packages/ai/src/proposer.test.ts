import { describe, expect, it } from 'vitest';
import { ProposalSchema, TUNABLE_FIELDS } from './proposer.js';

/**
 * The shape a policy proposal has to have before a human is asked to approve it.
 *
 * This is the narrowest safety boundary in the improvement loop. The agent reads an audit
 * trail and returns a diff; everything that stops that diff being arbitrary is here, in a
 * schema. Two tunable fields and nothing else, so "the agent proposed widening a compliance
 * bound" is not a sentence this system can produce.
 */

const base = {
  predicted_net_delta_paise: 1500,
  confidence: 0.65,
  summary: 'A summary long enough to clear the minimum length requirement.',
};

const change = (over: Record<string, unknown>): Record<string, unknown> => ({
  from_value: 500,
  to_value: 400,
  rationale: 'A rationale long enough to clear the minimum length requirement.',
  evidence_decision_ids: [],
  ...over,
});

const parse = (over: Record<string, unknown>): boolean =>
  ProposalSchema.safeParse({ ...base, changes: [change(over)] }).success;

describe('reason_code on a proposed change', () => {
  it('accepts a global change with reason_code OMITTED', () => {
    // THE BUG THIS TEST EXISTS FOR. `reason_code` was nullable but REQUIRED, so a global
    // `ev_floor_paise` change had to send `reason_code: null` explicitly — and the model
    // sent it most of the time, which is the worst possible frequency for a required key.
    // One run produced three usable changes; the next was discarded whole with
    // `changes.2.reason_code Required`.
    //
    // Losing an entire proposal over a missing key with exactly one possible value is
    // brittleness rather than strictness. There is no second reading of an absent reason
    // code on a field that is not per-code.
    expect(parse({ field: 'ev_floor_paise' })).toBe(true);
  });

  it('accepts a global change with an explicit null', () => {
    expect(parse({ field: 'ev_floor_paise', reason_code: null })).toBe(true);
  });

  it('accepts a per-code change that names its code', () => {
    expect(parse({ field: 'min_gap_hours', reason_code: 'issuer_down' })).toBe(true);
  });

  it('REFUSES a per-code change with no code', () => {
    // The coherence the required field was implicitly buying, now enforced deliberately.
    // `apply-policy.ts` already threw on this — but at apply time, which is AFTER the
    // proposal was stored and a human approved it. A person should never be shown a change
    // that cannot be applied to anything.
    expect(parse({ field: 'min_gap_hours' })).toBe(false);
    expect(parse({ field: 'min_gap_hours', reason_code: null })).toBe(false);
  });

  it('REFUSES a global change that names a code', () => {
    // `ev_floor_paise` is one number for the whole policy. A reason code attached to it
    // means the agent believes it is per-cause, and acting on that belief would apply a
    // global change while an operator read a scoped one.
    expect(parse({ field: 'ev_floor_paise', reason_code: 'issuer_down' })).toBe(false);
  });
});

describe('the safety envelope of a proposal', () => {
  it('permits exactly two fields', () => {
    // The enum is the mechanism, not the prompt. An agent cannot propose relaxing consent,
    // the contact ceiling or the pre-debit notice period, because there is no
    // representation for it — a proposal naming one fails to parse.
    expect(TUNABLE_FIELDS).toEqual(['min_gap_hours', 'ev_floor_paise']);
    expect(parse({ field: 'quiet_hours_start', reason_code: null })).toBe(false);
    expect(parse({ field: 'contact_ceiling_per_week', reason_code: null })).toBe(false);
  });

  it('refuses an unknown reason code', () => {
    expect(parse({ field: 'min_gap_hours', reason_code: 'made_up_cause' })).toBe(false);
  });

  it('caps a proposal at three changes', () => {
    // A diff a person can actually read before approving it. Twenty simultaneous edits is
    // not a reviewable proposal, it is a rewrite.
    const many = Array.from({ length: 4 }, () =>
      change({ field: 'min_gap_hours', reason_code: 'issuer_down' }),
    );
    expect(ProposalSchema.safeParse({ ...base, changes: many }).success).toBe(false);
  });

  it('refuses an empty proposal rather than treating it as a no-op', () => {
    expect(ProposalSchema.safeParse({ ...base, changes: [] }).success).toBe(false);
  });

  it('requires values to be integers', () => {
    // Every tunable is paise or whole hours. A float here would reach the YAML and then the
    // policy loader, where the money path has no way to represent it.
    expect(parse({ field: 'ev_floor_paise', to_value: 412.5 })).toBe(false);
  });

  it('requires a rationale substantial enough to review', () => {
    expect(parse({ field: 'ev_floor_paise', rationale: 'better' })).toBe(false);
  });
});
