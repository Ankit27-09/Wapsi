import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  BpsSchema,
  CHANNELS,
  RISK_CLASSES,
  PaiseSchema,
  RAILS,
  REASON_CODES,
  TimeWindowSchema,
  causeIsValidFor,
  interventionIsValidFor,
  type Channel,
  type Paise,
  type Rail,
  type ReasonCode,
  type RiskClass,
} from '@rc/core';
import { TimingSchema, type Timing } from './priors.js';

/**
 * The recovery policy, as versioned data.
 *
 * Loaded from YAML, validated, and hashed. The hash is stamped onto proposals so an
 * approval cannot be replayed against different content than the approver read.
 *
 * The shape here encodes one deliberate decision worth stating: a reason code's
 * `schedule` length IS its attempt cap. There is no separate `max_attempts` field,
 * because two sources of truth for "how many tries are permitted" is one more than can
 * be kept in step — and the failure mode of them disagreeing is spending money past a
 * ceiling that a reader of the config believed was in force.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Actions a schedule step may take.
 *
 * Only `retry` and `switch_rail` present a charge, and therefore only those two incur a
 * gateway fee. That distinction is load-bearing rather than cosmetic: an abandoned checkout
 * was never charged, so pricing its recovery nudge as though it costs ₹3.50 in fees would
 * make the expected-value gate refuse interventions that in reality cost eighteen paise.
 */
const ScheduleActionSchema = z.enum([
  'retry',
  'switch_rail',
  'payment_link',
  'notify',
  'pre_debit_notify',
  'remandate',
]);

/** Actions whose entire mechanism is a message, so a registered template is mandatory. */
const MESSAGE_ACTIONS = new Set(['payment_link', 'notify', 'pre_debit_notify', 'remandate']);

const ScheduleEntrySchema = z.object({
  action: ScheduleActionSchema,
  timing: TimingSchema,
  /** Required in practice for `switch_rail`; enforced by the refinement below. */
  rail: z.enum(RAILS).optional(),
  notify: z.boolean().default(false),
  /**
   * Overrides the reason code's default template for this step.
   *
   * This is how an escalation ladder climbs channels. The template carries its own channel,
   * so naming a voice template at step three is the whole mechanism — there is no separate
   * `channel` field, because two fields that must agree eventually will not.
   */
  template: z.string().optional(),
});

const ReasonPolicySchema = z
  .object({
    label: z.string().min(1),
    schedule: z.array(ScheduleEntrySchema),
    min_gap_hours: z.number().int().min(0).max(720).default(0),
    escalate: z.boolean().default(false),
    notify_on_escalate: z.boolean().default(false),
    template: z.string().optional(),
    note: z.string().optional(),
  })
  .superRefine((policy, ctx) => {
    for (const [index, entry] of policy.schedule.entries()) {
      if (entry.action === 'switch_rail' && entry.rail === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule', index, 'rail'],
          message: 'A switch_rail entry must name the rail to switch to',
        });
      }
      const wantsMessage = entry.notify || MESSAGE_ACTIONS.has(entry.action);
      const hasTemplate = entry.template !== undefined || policy.template !== undefined;

      if (wantsMessage && !hasTemplate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['template'],
          message:
            `A ${entry.action} step needs a registered template. Free-form message text ` +
            'cannot be sent on a regulated channel in India, so a step that messages with ' +
            'no template is unshippable rather than merely incomplete.',
        });
      }
    }

    // A code that permits no attempts must say what happens instead. Silence here would
    // mean a transaction that is neither retried nor escalated — quietly abandoned.
    if (policy.schedule.length === 0 && !policy.escalate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['escalate'],
        message: 'A reason code with an empty schedule must set escalate: true',
      });
    }

    if (policy.notify_on_escalate && policy.template === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['template'],
        message: 'notify_on_escalate requires a registered template',
      });
    }
  });

const RangeSchema = z
  .object({ min: z.number().int(), max: z.number().int() })
  .refine((range) => range.min <= range.max, { message: 'min must not exceed max' });

const PolicyFileSchema = z.object({
  version: z.number().int().min(1),
  approved_by: z.string().min(1),

  global: z.object({
    kill_switch: z.boolean(),
    quiet_hours: TimeWindowSchema,
    max_contacts_per_customer_per_week: z.number().int().min(0).max(20),
    max_total_fee_spend_per_batch_paise: PaiseSchema,
    ev_floor_paise: PaiseSchema,
    default_contribution_margin_bps: BpsSchema,
    require_consent_for_channels: z.array(z.enum(CHANNELS)),

    /**
     * Outbound calling, which is regulated separately from messaging and priced twenty
     * times higher. Its own window and its own ceiling, both tighter than the messaging
     * equivalents.
     */
    voice: z.object({
      window: TimeWindowSchema,
      max_calls_per_customer_per_week: z.number().int().min(0).max(5),
    }),

    /** Hours a pre-debit notification must precede an e-mandate debit. RBI minimum is 24. */
    pre_debit_notice_hours: z.number().int().min(24).max(168),

    /**
     * How many billing cycles a recovered subscription is assumed to survive when the
     * transaction does not say. The value term multiplies by this, so it is the single
     * figure that decides how much more a subscription retry is worth than a one-off.
     */
    default_lifetime_cycles: z.number().int().min(1).max(120),
  }),

  costs: z.object({
    gateway_fee_paise: z.record(z.enum(RAILS), PaiseSchema),
    message_cost_paise: z.record(z.enum(CHANNELS), PaiseSchema),
    llm_amortised_paise: PaiseSchema,
  }),

  tunable: z.record(z.string(), RangeSchema),

  // Every reason code in the taxonomy needs an entry. A missing one would mean a
  // classified failure with no defined response, which is a gap the engine would have to
  // improvise around at runtime.
  reason_codes: z.record(z.enum(REASON_CODES), ReasonPolicySchema),

  /**
   * Per-risk-class overrides.
   *
   * The same cause means different things in different classes and earns a different
   * response. `insufficient_funds` on a one-off card payment is a timing problem worth one
   * probe and one aligned retry. The same code on a live subscription is worth far more —
   * the downside is the whole remaining relationship, not this cycle — and it is debited
   * under an e-mandate, so a charge is unlawful without a pre-debit notification first.
   *
   * Expressed as overrides rather than a full matrix on purpose: a matrix of 5 classes ×
   * 18 codes would be 90 entries, most of them identical, and the duplicates are where
   * config drifts out of step with itself.
   */
  class_overrides: z
    .record(z.enum(RISK_CLASSES), z.record(z.enum(REASON_CODES), ReasonPolicySchema))
    .default({}),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type ReasonPolicy = z.infer<typeof ReasonPolicySchema>;

// ---------------------------------------------------------------------------
// The loaded policy
// ---------------------------------------------------------------------------

export interface Policy {
  readonly version: number;
  readonly approvedBy: string;
  /** sha256 of the source YAML. Stamped onto proposals and audit rows. */
  readonly hash: string;
  /** The original text, snapshotted into `policy_version` so history is reconstructable. */
  readonly yaml: string;

  readonly killSwitch: boolean;
  readonly quietHours: z.infer<typeof TimeWindowSchema>;
  readonly maxContactsPerWeek: number;
  readonly maxBatchFeeSpend: Paise;
  readonly evFloor: Paise;
  readonly defaultMarginBps: z.infer<typeof BpsSchema>;
  readonly consentRequiredChannels: readonly Channel[];
  readonly llmAmortisedCost: Paise;

  readonly voiceWindow: z.infer<typeof TimeWindowSchema>;
  readonly maxCallsPerWeek: number;
  readonly preDebitNoticeHours: number;
  readonly defaultLifetimeCycles: number;

  gatewayFee(rail: Rail): Paise;
  messageCost(channel: Channel): Paise;

  /**
   * The strategy for a cause, in a class.
   *
   * `riskClass` is optional so the many call sites that only ever see one-off payments read
   * unchanged; omitting it means the base entry, which is the `payment_failure` strategy.
   */
  forReason(code: ReasonCode, riskClass?: RiskClass): ReasonPolicy;
  /** The schedule entry for a 1-indexed attempt, or undefined if the cap is reached. */
  scheduleEntry(
    code: ReasonCode,
    attemptNo: number,
    riskClass?: RiskClass,
  ): ScheduleEntry | undefined;
  /** Schedule length. The attempt cap, by construction. */
  attemptCap(code: ReasonCode, riskClass?: RiskClass): number;

  /** Range clamp for a tunable field, for validating proposals. */
  tunableRange(field: string): { readonly min: number; readonly max: number } | undefined;
}

export function buildPolicy(yamlText: string): Policy {
  const parsed = PolicyFileSchema.parse(parse(yamlText));
  const hash = createHash('sha256').update(yamlText).digest('hex');

  // Zod's `record` with an enum key does not require every key to be present, so
  // completeness is asserted here rather than assumed. A reason code with no policy would
  // otherwise surface as a runtime failure mid-batch.
  const missing = REASON_CODES.filter((code) => parsed.reason_codes[code] === undefined);
  if (missing.length > 0) {
    throw new Error(`Policy is missing entries for reason codes: ${missing.join(', ')}`);
  }

  const missingFees = RAILS.filter((rail) => parsed.costs.gateway_fee_paise[rail] === undefined);
  if (missingFees.length > 0) {
    throw new Error(`Policy is missing gateway fees for rails: ${missingFees.join(', ')}`);
  }

  const missingMessageCosts = CHANNELS.filter(
    (channel) => parsed.costs.message_cost_paise[channel] === undefined,
  );
  if (missingMessageCosts.length > 0) {
    throw new Error(
      `Policy is missing message costs for channels: ${missingMessageCosts.join(', ')}`,
    );
  }

  // Every override must name a cause its class can actually have, and every action it
  // schedules must be legal for that class. Both are checked at load, not at decision time:
  // a policy that schedules a retry for a lapsed mandate is a config error that should
  // refuse to load, not a surprise discovered mid-batch on one unlucky transaction.
  for (const [rawClass, overrides] of Object.entries(parsed.class_overrides)) {
    const riskClass = rawClass as RiskClass;
    for (const [rawCode, entry] of Object.entries(overrides ?? {})) {
      const code = rawCode as ReasonCode;
      if (!causeIsValidFor(riskClass, code)) {
        throw new Error(
          `class_overrides.${riskClass}.${code}: ${code} is not a cause ${riskClass} can have`,
        );
      }
      for (const step of entry.schedule) {
        if (!interventionIsValidFor(riskClass, step.action)) {
          throw new Error(
            `class_overrides.${riskClass}.${code}: ${step.action} is not a legal ` +
              `intervention for ${riskClass}`,
          );
        }
      }
    }
  }

  // The base entries are the fallback for EVERY class that does not override them, so they
  // must be legal in all of those classes — not merely in one. This is what catches the
  // expensive version of the mistake: a base `retry` inherited by a class with no live
  // authorisation to debit, which would spend a fee against a probability of exactly zero.
  for (const code of REASON_CODES) {
    const base = parsed.reason_codes[code];
    if (base === undefined) continue;
    for (const riskClass of RISK_CLASSES) {
      if (!causeIsValidFor(riskClass, code)) continue;
      if (parsed.class_overrides[riskClass]?.[code] !== undefined) continue;
      for (const step of base.schedule) {
        if (!interventionIsValidFor(riskClass, step.action)) {
          throw new Error(
            `reason_codes.${code} schedules ${step.action}, which ${riskClass} does not ` +
              `permit. ${riskClass} inherits this entry because it has no override for ` +
              `${code}; add one, or remove the step.`,
          );
        }
      }
    }
  }

  const forReason = (code: ReasonCode, riskClass?: RiskClass): ReasonPolicy => {
    if (riskClass !== undefined) {
      const override = parsed.class_overrides[riskClass]?.[code];
      if (override !== undefined) return override;
    }
    const entry = parsed.reason_codes[code];
    if (entry === undefined) throw new Error(`unreachable: policy validated for ${code}`);
    return entry;
  };

  return {
    version: parsed.version,
    approvedBy: parsed.approved_by,
    hash,
    yaml: yamlText,

    killSwitch: parsed.global.kill_switch,
    quietHours: parsed.global.quiet_hours,
    maxContactsPerWeek: parsed.global.max_contacts_per_customer_per_week,
    maxBatchFeeSpend: parsed.global.max_total_fee_spend_per_batch_paise,
    evFloor: parsed.global.ev_floor_paise,
    defaultMarginBps: parsed.global.default_contribution_margin_bps,
    consentRequiredChannels: parsed.global.require_consent_for_channels,
    llmAmortisedCost: parsed.costs.llm_amortised_paise,

    voiceWindow: parsed.global.voice.window,
    maxCallsPerWeek: parsed.global.voice.max_calls_per_customer_per_week,
    preDebitNoticeHours: parsed.global.pre_debit_notice_hours,
    defaultLifetimeCycles: parsed.global.default_lifetime_cycles,

    gatewayFee(rail) {
      const fee = parsed.costs.gateway_fee_paise[rail];
      if (fee === undefined) throw new Error(`unreachable: fee validated for ${rail}`);
      return fee;
    },

    messageCost(channel) {
      const cost = parsed.costs.message_cost_paise[channel];
      if (cost === undefined) throw new Error(`unreachable: cost validated for ${channel}`);
      return cost;
    },

    forReason,
    scheduleEntry: (code, attemptNo, riskClass) =>
      forReason(code, riskClass).schedule[attemptNo - 1],
    attemptCap: (code, riskClass) => forReason(code, riskClass).schedule.length,
    tunableRange: (field) => parsed.tunable[field],
  };
}

export function loadPolicy(path?: string): Policy {
  const file = path ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'policy.default.yaml');
  return buildPolicy(readFileSync(file, 'utf8'));
}

/** The timing a given attempt would use, for looking up its published prior. */
export function timingFor(
  policy: Policy,
  code: ReasonCode,
  attemptNo: number,
  riskClass?: RiskClass,
): Timing | undefined {
  return policy.scheduleEntry(code, attemptNo, riskClass)?.timing;
}
