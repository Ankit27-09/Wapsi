import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CHANNELS, REASON_CODES, mayEverContact, paise, type Channel, type ReasonCode } from '@rc/core';
import { checkAttemptBounds, checkContactBounds, type ConsentState } from './bounds.js';
import { buildPolicy, loadPolicy, type Policy } from './policy.js';

/**
 * Properties of the bounds checker.
 *
 * These are the rules that make the system incapable of acting outside its authorisation
 * rather than merely unlikely to. Each is asserted over every reason code and a generated
 * range of histories, because the interesting failures are combinations nobody thought to
 * write an example for.
 */

const policy = loadPolicy();

/**
 * The same policy with the kill switch engaged.
 *
 * Built by editing the YAML and re-running the real loader, rather than by mutating the
 * object. That keeps the test honest about the path production takes — the switch is a
 * config change, and this proves a config change is all it takes.
 */
const killed: Policy = buildPolicy(flipKillSwitch(policy.yaml));

function flipKillSwitch(yamlText: string): string {
  const flipped = yamlText.replace('kill_switch: false', 'kill_switch: true');
  if (flipped === yamlText) {
    throw new Error('Fixture is stale: no `kill_switch: false` line found in the policy');
  }
  return flipped;
}

const anyReasonCode = fc.constantFrom(...REASON_CODES);
const anyChannel = fc.constantFrom(...CHANNELS);
const anyConsent = fc.constantFrom<ConsentState>('opt_in', 'opt_out', 'unknown');

/** 14:30 IST — comfortably outside quiet hours, for tests about other rules. */
const MIDDAY_IST = new Date('2026-06-03T09:00:00.000Z');

function attemptInput(overrides: {
  readonly reasonCode: ReasonCode;
  readonly attemptNo: number;
  readonly hoursSinceLastAttempt?: number | null;
  readonly policy?: Policy;
  readonly feeRemaining?: bigint;
  readonly fee?: bigint;
}) {
  return {
    now: MIDDAY_IST,
    policy: overrides.policy ?? policy,
    reasonCode: overrides.reasonCode,
    attemptNo: overrides.attemptNo,
    hoursSinceLastAttempt: overrides.hoursSinceLastAttempt ?? null,
    batchFeeRemaining: paise(overrides.feeRemaining ?? 500_000n),
    gatewayFee: paise(overrides.fee ?? 350n),
  };
}

function contactInput(overrides: {
  readonly reasonCode: ReasonCode;
  readonly channel: Channel;
  readonly consent?: ConsentState;
  readonly contactsThisWeek?: number;
  readonly now?: Date;
  readonly policy?: Policy;
  readonly hasRegisteredTemplate?: boolean;
}) {
  return {
    now: overrides.now ?? MIDDAY_IST,
    policy: overrides.policy ?? policy,
    reasonCode: overrides.reasonCode,
    channel: overrides.channel,
    consent: overrides.consent ?? 'opt_in',
    contactsThisWeek: overrides.contactsThisWeek ?? 0,
    hasRegisteredTemplate: overrides.hasRegisteredTemplate ?? true,
  };
}

describe('the kill switch is absolute', () => {
  it('blocks every attempt, for every reason code and every attempt number', () => {
    fc.assert(
      fc.property(anyReasonCode, fc.integer({ min: 1, max: 5 }), (reasonCode, attemptNo) => {
        const verdict = checkAttemptBounds(
          attemptInput({ reasonCode, attemptNo, policy: killed }),
        );
        expect(verdict.kind).toBe('block');
        if (verdict.kind === 'block') expect(verdict.rule).toBe('kill_switch');
      }),
    );
  });

  it('blocks every contact, and reports the kill switch rather than a lesser rule', () => {
    // Reporting the most fundamental blocking rule matters operationally: "contact
    // ceiling reached" would be true too, and would send someone looking in the wrong
    // place while the whole system was halted.
    fc.assert(
      fc.property(anyReasonCode, anyChannel, anyConsent, (reasonCode, channel, consent) => {
        const verdict = checkContactBounds(
          contactInput({ reasonCode, channel, consent, policy: killed }),
        );
        expect(verdict.kind).toBe('block');
        if (verdict.kind === 'block') expect(verdict.rule).toBe('kill_switch');
      }),
    );
  });
});

describe('attempt caps hold', () => {
  it('permits every attempt inside the schedule and none beyond it', () => {
    fc.assert(
      fc.property(anyReasonCode, fc.integer({ min: 1, max: 8 }), (reasonCode, attemptNo) => {
        const cap = policy.attemptCap(reasonCode);
        const verdict = checkAttemptBounds(attemptInput({ reasonCode, attemptNo }));

        if (cap === 0) {
          // Terminal: not a low probability, a structural zero. Must never spend a fee.
          expect(verdict.kind).toBe('block');
          if (verdict.kind === 'block') expect(verdict.rule).toBe('terminal');
          return;
        }

        if (attemptNo > cap) {
          expect(verdict.kind).toBe('block');
          if (verdict.kind === 'block') expect(verdict.rule).toBe('attempt_cap');
        } else {
          expect(verdict.kind).toBe('allow');
        }
      }),
    );
  });

  it('never permits an attempt on a code whose schedule is empty', () => {
    const terminal = REASON_CODES.filter((code) => policy.attemptCap(code) === 0);
    // Guards against the schedule quietly gaining an entry for a code where success is
    // impossible — the config change that would look harmless in review.
    expect(terminal).toEqual(
      expect.arrayContaining(['card_expired', 'mandate_expired', 'suspected_fraud_block', 'unknown']),
    );
  });
});

describe('minimum gap between attempts', () => {
  it('blocks a retry that arrives sooner than the code requires', () => {
    fc.assert(
      fc.property(anyReasonCode, fc.integer({ min: 0, max: 200 }), (reasonCode, hours) => {
        const cap = policy.attemptCap(reasonCode);
        if (cap < 2) return; // no second attempt to gap

        const minGap = policy.forReason(reasonCode).min_gap_hours;
        const verdict = checkAttemptBounds(
          attemptInput({ reasonCode, attemptNo: 2, hoursSinceLastAttempt: hours }),
        );

        if (minGap > 0 && hours < minGap) {
          expect(verdict.kind).toBe('block');
          if (verdict.kind === 'block') expect(verdict.rule).toBe('min_gap');
        } else {
          expect(verdict.kind).toBe('allow');
        }
      }),
    );
  });

  it('does not apply a gap to the first attempt', () => {
    fc.assert(
      fc.property(anyReasonCode, (reasonCode) => {
        if (policy.attemptCap(reasonCode) === 0) return;
        const verdict = checkAttemptBounds(
          attemptInput({ reasonCode, attemptNo: 1, hoursSinceLastAttempt: null }),
        );
        expect(verdict.kind).toBe('allow');
      }),
    );
  });
});

describe('the batch fee budget is a ceiling', () => {
  it('blocks an attempt whose fee exceeds what is left, and allows one that exactly exhausts it', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2_000n }),
        fc.bigInt({ min: 1n, max: 2_000n }),
        (remaining, fee) => {
          const verdict = checkAttemptBounds(
            attemptInput({
              reasonCode: 'insufficient_funds',
              attemptNo: 1,
              feeRemaining: remaining,
              fee,
            }),
          );

          // Exactly exhausting the budget is permitted; the database CHECK constraint
          // draws the boundary in the same place, so the two layers agree.
          if (fee > remaining) {
            expect(verdict.kind).toBe('block');
            if (verdict.kind === 'block') expect(verdict.rule).toBe('batch_fee_budget');
          } else {
            expect(verdict.kind).toBe('allow');
          }
        },
      ),
    );
  });
});

describe('quiet hours', () => {
  /** Build an instant at a given IST wall-clock hour, via an explicit offset. */
  const atIst = (hour: number, minute: number): Date =>
    new Date(
      `2026-06-03T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`,
    );

  it('blocks every contact between 21:00 and 09:00 IST', () => {
    // Hours are enumerated explicitly rather than derived from the policy, so the test
    // would fail if the window were narrowed by accident — deriving the expectation from
    // the same config the code reads would make this tautological.
    const quietHours = [21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8];

    fc.assert(
      fc.property(
        fc.constantFrom(...quietHours),
        fc.integer({ min: 0, max: 59 }),
        (hour, minute) => {
          const verdict = checkContactBounds(
            contactInput({
              reasonCode: 'insufficient_funds',
              channel: 'sms',
              now: atIst(hour, minute),
            }),
          );
          expect(verdict.kind).toBe('block');
          if (verdict.kind === 'block') expect(verdict.rule).toBe('quiet_hours');
        },
      ),
    );
  });

  it('permits contact between 09:00 and 21:00 IST', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 9, max: 20 }),
        fc.integer({ min: 0, max: 59 }),
        (hour, minute) => {
          const verdict = checkContactBounds(
            contactInput({
              reasonCode: 'insufficient_funds',
              channel: 'sms',
              now: atIst(hour, minute),
            }),
          );
          expect(verdict.kind).toBe('allow');
        },
      ),
    );
  });

  it('does not block the attempt itself — a silent retry at 03:00 is fine', () => {
    // The reason the two checks are separate functions. Collapsing them would mean quiet
    // hours costing recoveries, because a perfectly good retry would be declined for want
    // of an optional nudge.
    const verdict = checkAttemptBounds({
      ...attemptInput({ reasonCode: 'insufficient_funds', attemptNo: 1 }),
      now: atIst(3, 0),
    });
    expect(verdict.kind).toBe('allow');
  });
});

describe('consent and contact ceilings', () => {
  it('never contacts without an explicit opt-in on a regulated channel', () => {
    fc.assert(
      fc.property(anyChannel, fc.constantFrom<ConsentState>('opt_out', 'unknown'), (channel, consent) => {
        const verdict = checkContactBounds(
          contactInput({ reasonCode: 'insufficient_funds', channel, consent }),
        );
        expect(verdict.kind).toBe('block');
        if (verdict.kind === 'block') expect(verdict.rule).toBe('consent');
      }),
    );
  });

  it('never contacts a code marked never-contact, whatever the consent state', () => {
    // Consent is a property of the person; never-contact is a property of the failure.
    // Both must permit the send, and this asserts the second cannot be overridden by the
    // first — a risk-flagged customer with an opt-in is still not contactable.
    const forbidden = REASON_CODES.filter((code) => !mayEverContact(code));
    expect(forbidden.length).toBeGreaterThan(0);

    fc.assert(
      fc.property(fc.constantFrom(...forbidden), anyChannel, anyConsent, (reasonCode, channel, consent) => {
        const verdict = checkContactBounds(contactInput({ reasonCode, channel, consent }));
        expect(verdict.kind).toBe('block');
        if (verdict.kind === 'block') expect(verdict.rule).toBe('never_contact');
      }),
    );
  });

  it('enforces the weekly contact ceiling', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6 }), (contactsThisWeek) => {
        const verdict = checkContactBounds(
          contactInput({ reasonCode: 'insufficient_funds', channel: 'sms', contactsThisWeek }),
        );

        if (contactsThisWeek >= policy.maxContactsPerWeek) {
          expect(verdict.kind).toBe('block');
          if (verdict.kind === 'block') expect(verdict.rule).toBe('contact_ceiling');
        } else {
          expect(verdict.kind).toBe('allow');
        }
      }),
    );
  });

  it('refuses to send without a registered template', () => {
    // Commercial SMS in India requires a DLT-registered template. A send with none is
    // unshippable rather than merely unpolished, so it is a bound and not a warning.
    const verdict = checkContactBounds(
      contactInput({
        reasonCode: 'insufficient_funds',
        channel: 'sms',
        hasRegisteredTemplate: false,
      }),
    );
    expect(verdict.kind).toBe('block');
    if (verdict.kind === 'block') expect(verdict.rule).toBe('no_template');
  });
});
