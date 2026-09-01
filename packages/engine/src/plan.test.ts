import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  REASON_CODES,
  bps,
  isTerminal,
  mayEverContact,
  paise,
  paiseFromRupeeString,
  templateId,
  toRupeeString,
  type Rail,
  type ReasonCode,
} from '@rc/core';
import { buildPolicy, loadPolicy, loadPriorTable, type Policy } from '@rc/policy';
import { planNext, type PlanInput, type TemplateRef } from './plan.js';

/**
 * Properties of the planner.
 *
 * The planner decides whether money moves, so its behaviour is asserted across every
 * reason code and a generated range of histories rather than over a few examples. The
 * interesting failures on this problem are combinations — a terminal code that also has a
 * template, an opted-out customer inside quiet hours on the last permitted attempt — and
 * nobody writes examples for those.
 */

const policy = loadPolicy();
const priors = loadPriorTable();

const killed: Policy = buildPolicy(
  policy.yaml.replace('kill_switch: false', 'kill_switch: true'),
);

/** 14:30 IST — outside quiet hours, so contact rules other than time can be tested. */
const MIDDAY_IST = new Date('2026-06-03T09:00:00.000Z');

const REGISTERED_SMS: TemplateRef = {
  id: templateId('tpl_if_reminder_v3'),
  channel: 'sms',
  registered: true,
};

function input(overrides: Partial<PlanInput> & { readonly reasonCode: ReasonCode }): PlanInput {
  return {
    now: MIDDAY_IST,
    policy,
    priors,
    amount: paiseFromRupeeString('5000.00'),
    marginBps: bps(1900),
    currentRail: 'card' satisfies Rail,
    attemptNo: 1,
    hoursSinceLastAttempt: null,
    contactsThisWeek: 0,
    consent: 'opt_in',
    template: REGISTERED_SMS,
    batchFeeRemaining: paiseFromRupeeString('5000.00'),
    ...overrides,
  };
}

const anyReasonCode = fc.constantFrom(...REASON_CODES);

describe('planNext — every plan carries its arithmetic', () => {
  it('reports expected-value figures on refusals as well as on fired attempts', () => {
    // The reason the decision table records refusals at all. A blocked transaction that
    // cannot say what it would have been worth is a log line, not an audit record.
    fc.assert(
      fc.property(anyReasonCode, fc.integer({ min: 1, max: 5 }), (reasonCode, attemptNo) => {
        const plan = planNext(input({ reasonCode, attemptNo, hoursSinceLastAttempt: 999 }));

        expect(typeof plan.ev.value).toBe('bigint');
        expect(typeof plan.ev.cost).toBe('bigint');
        expect(typeof plan.ev.net).toBe('bigint');
        // Contribution margin at stake is a property of the transaction, so it is known
        // even when nothing is permitted to happen.
        expect(plan.ev.value).toBe(paiseFromRupeeString('950.00'));
      }),
    );
  });
});

describe('planNext — structural impossibility', () => {
  it('never fires an attempt on a terminal reason code', () => {
    // Not "rarely", and not "because the floor happens to be set high enough". An expired
    // card or a revoked mandate has nothing to debit, so no combination of amount, margin
    // or history may produce a fired attempt.
    const terminal = REASON_CODES.filter(isTerminal);
    expect(terminal.length).toBeGreaterThan(0);

    fc.assert(
      fc.property(
        fc.constantFrom(...terminal),
        fc.integer({ min: 1, max: 5 }),
        fc.bigInt({ min: 1n, max: 50_000_000n }),
        (reasonCode, attemptNo, amount) => {
          const plan = planNext(
            input({ reasonCode, attemptNo, amount: paise(amount), marginBps: bps(10_000) }),
          );
          expect(plan.kind).toBe('refuse');
          if (plan.kind === 'refuse') expect(plan.verdict).toBe('refuse_terminal');
        },
      ),
    );
  });

  it('escalates a terminal code rather than abandoning the transaction', () => {
    const plan = planNext(input({ reasonCode: 'card_expired' }));
    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') return;

    // The attempt is refused; the money is not written off. An expired card is a
    // messaging problem wearing a retry problem's clothes.
    expect(plan.action).toBe('escalate');
    expect(plan.verdict).toBe('refuse_terminal');
  });
});

describe('planNext — the kill switch', () => {
  it('refuses everything and reports itself as the reason', () => {
    fc.assert(
      fc.property(anyReasonCode, fc.integer({ min: 1, max: 5 }), (reasonCode, attemptNo) => {
        const plan = planNext(input({ reasonCode, attemptNo, policy: killed }));
        expect(plan.kind).toBe('refuse');
        if (plan.kind === 'refuse') expect(plan.verdict).toBe('refuse_kill_switch');
        expect(plan.contact.send).toBe(false);
      }),
    );
  });
});

describe('planNext — contact is decided separately from the attempt', () => {
  it('fires the retry but suppresses the message inside quiet hours', () => {
    // The single most important consequence of splitting the two bound checks. A recovery
    // system that declined a good retry because it could not send an optional nudge would
    // be losing money to politeness.
    const at3am = new Date('2026-06-03T03:00:00+05:30');
    const plan = planNext(
      input({ reasonCode: 'insufficient_funds', attemptNo: 2, hoursSinceLastAttempt: 72, now: at3am }),
    );

    expect(plan.kind).toBe('fire');
    expect(plan.contact.send).toBe(false);
    if (!plan.contact.send) expect(plan.contact.blockedBy).toBe('quiet_hours');
  });

  it('does not bill a suppressed message against the transaction', () => {
    const at3am = new Date('2026-06-03T03:00:00+05:30');
    const args = {
      reasonCode: 'insufficient_funds' as const,
      attemptNo: 2,
      hoursSinceLastAttempt: 72,
    };

    const suppressed = planNext(input({ ...args, now: at3am }));
    const sent = planNext(input({ ...args, now: MIDDAY_IST }));

    // A nudge nobody received must not appear in the cost of the attempt, or reported net
    // value quietly understates itself by the price of every blocked message.
    expect(sent.ev.cost).toBe(
      suppressed.ev.cost + policy.messageCost('sms'),
    );
  });

  it('never contacts a customer about a code marked never-contact', () => {
    const forbidden = REASON_CODES.filter((code) => !mayEverContact(code));

    fc.assert(
      fc.property(fc.constantFrom(...forbidden), (reasonCode) => {
        const plan = planNext(input({ reasonCode, template: REGISTERED_SMS }));
        expect(plan.contact.send).toBe(false);
      }),
    );
  });

  it('refuses to send through an unregistered template', () => {
    const plan = planNext(
      input({
        reasonCode: 'insufficient_funds',
        attemptNo: 2,
        hoursSinceLastAttempt: 72,
        template: { ...REGISTERED_SMS, registered: false },
      }),
    );

    expect(plan.kind).toBe('fire');
    expect(plan.contact.send).toBe(false);
    if (!plan.contact.send) expect(plan.contact.blockedBy).toBe('no_template');
  });
});

describe('planNext — rail switching', () => {
  it('moves off the failed rail for an authentication timeout', () => {
    const plan = planNext(input({ reasonCode: 'threeds_timeout', currentRail: 'card' }));

    expect(plan.kind).toBe('fire');
    if (plan.kind !== 'fire') return;

    // The instrument is fine; the flow failed. Re-presenting the same 3DS challenge on
    // the same network reproduces the failure, so the schedule names a different rail.
    expect(plan.action).toBe('switch_rail');
    expect(plan.rail).toBe('upi_intent');
    expect(plan.rail).not.toBe('card');
  });

  it('prices the attempt against the rail it will actually use', () => {
    const plan = planNext(input({ reasonCode: 'threeds_timeout', currentRail: 'card' }));
    expect(plan.kind).toBe('fire');
    if (plan.kind !== 'fire') return;

    // A card fee of ₹3.50 against a UPI fee of ₹0.80: charging the wrong one would make
    // every rail-switch decision economically wrong in the same direction.
    const expectedCost =
      policy.gatewayFee('upi_intent') + policy.messageCost('sms') + policy.llmAmortisedCost;
    expect(plan.ev.cost).toBe(expectedCost);
  });
});

describe('planNext — the expected-value gate does the stopping', () => {
  it('refuses a do_not_honour probe when the margin cannot pay for it', () => {
    // `do_not_honour` is uninformative by network design, so no schedule can be targeted
    // at it and the economics are the only real control.
    //
    // The figures are worth spelling out, because they show how TIGHT the refusal region
    // actually is under the shipped policy: ₹10,000 at 0.5% margin puts ₹50 at stake, the
    // published prior gives it a 15% chance, so ₹7.50 is expected against a ₹3.54 probe —
    // ₹3.96 net, just under the ₹5 floor. Anything much larger, or at any normal margin,
    // clears comfortably. That is a real observation about this configuration rather than
    // a contrived example, and it is the kind of thing the eval report should surface: a
    // ₹5 floor bites rarely, and whether it should is a question for the sweep.
    const plan = planNext(
      input({
        reasonCode: 'do_not_honour',
        amount: paiseFromRupeeString('10000.00'),
        marginBps: bps(50),
      }),
    );

    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') return;
    expect(plan.verdict).toBe('refuse_ev');
    expect(toRupeeString(plan.ev.net)).toBe('3.96');
  });

  it('fires the same probe at a normal D2C margin', () => {
    // Same ticket, 26% margin: ₹2,600 at stake, ₹390 expected, ₹386.46 net.
    const plan = planNext(
      input({
        reasonCode: 'do_not_honour',
        amount: paiseFromRupeeString('10000.00'),
        marginBps: bps(2600),
      }),
    );

    expect(plan.kind).toBe('fire');
    expect(toRupeeString(plan.ev.net)).toBe('386.46');
  });

  it('reports the bound rather than the economics when both would block', () => {
    // An operator needs to know the system is halted, not that the transaction was
    // marginal. Ordering the checks this way is what makes the exception queue diagnostic
    // instead of merely correct.
    const plan = planNext(
      input({
        reasonCode: 'insufficient_funds',
        attemptNo: 2,
        hoursSinceLastAttempt: 1, // violates the 48h gap
        amount: paiseFromRupeeString('1.00'), // and would fail on economics too
        marginBps: bps(1),
      }),
    );

    expect(plan.kind).toBe('refuse');
    if (plan.kind === 'refuse') expect(plan.verdict).toBe('refuse_bounds');
  });
});

describe('planNext — configuration errors surface loudly', () => {
  it('throws when the policy schedules a timing the priors do not cover', () => {
    // A silent zero here would look exactly like a correct structural refusal, and the
    // system would appear to work while systematically declining a recoverable class.
    const broken = buildPolicy(
      policy.yaml.replace(
        '      - { action: retry, timing: immediate }\n      - { action: retry, timing: salary_window, notify: true }',
        '      - { action: retry, timing: medium_backoff }',
      ),
    );

    expect(() =>
      planNext(input({ reasonCode: 'insufficient_funds', policy: broken })),
    ).toThrow(/no entry for it/);
  });
});

describe('planNext — a worked end-to-end figure', () => {
  it('prices the canonical salary-window retry exactly', () => {
    const plan = planNext(
      input({
        reasonCode: 'insufficient_funds',
        attemptNo: 2,
        hoursSinceLastAttempt: 72,
        amount: paiseFromRupeeString('4872.13'),
        marginBps: bps(1900),
      }),
    );

    expect(plan.kind).toBe('fire');
    if (plan.kind !== 'fire') return;

    // ₹4,872.13 × 19% = ₹925.70 at stake.
    // Published prior for attempt 2 at salary_window is 4500 bps.
    // Cost: ₹3.50 card fee + ₹0.18 SMS + ₹0.04 model = ₹3.72.
    // Net: ₹925.70 × 45% − ₹3.72 = ₹416.57 − ₹3.72 = ₹412.85
    expect(toRupeeString(plan.ev.value)).toBe('925.70');
    expect(plan.ev.pBps).toBe(4500);
    expect(toRupeeString(plan.ev.cost)).toBe('3.72');
    expect(toRupeeString(plan.ev.net)).toBe('412.85');
    expect(plan.timing).toBe('salary_window');
  });
});
