import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  BpsSchema,
  CHANNELS,
  PaiseSchema,
  RAILS,
  REASON_CODES,
  TimeWindowSchema,
  type Channel,
  type Paise,
  type Rail,
  type ReasonCode,
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

const ScheduleEntrySchema = z.object({
  action: z.enum(['retry', 'switch_rail']),
  timing: TimingSchema,
  /** Required in practice for `switch_rail`; enforced by the refinement below. */
  rail: z.enum(RAILS).optional(),
  notify: z.boolean().default(false),
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
      if (entry.notify && policy.template === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['template'],
          message:
            'An entry with notify: true needs a template. Free-form message text cannot ' +
            'be sent on a regulated channel in India, so a notify with no registered ' +
            'template is unshippable rather than merely incomplete.',
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

  gatewayFee(rail: Rail): Paise;
  messageCost(channel: Channel): Paise;

  forReason(code: ReasonCode): ReasonPolicy;
  /** The schedule entry for a 1-indexed attempt, or undefined if the cap is reached. */
  scheduleEntry(code: ReasonCode, attemptNo: number): ScheduleEntry | undefined;
  /** Schedule length. The attempt cap, by construction. */
  attemptCap(code: ReasonCode): number;

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

  const forReason = (code: ReasonCode): ReasonPolicy => {
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
    scheduleEntry: (code, attemptNo) => forReason(code).schedule[attemptNo - 1],
    attemptCap: (code) => forReason(code).schedule.length,
    tunableRange: (field) => parsed.tunable[field],
  };
}

export function loadPolicy(path?: string): Policy {
  const file = path ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'policy.default.yaml');
  return buildPolicy(readFileSync(file, 'utf8'));
}

/** The timing a given attempt would use, for looking up its published prior. */
export function timingFor(policy: Policy, code: ReasonCode, attemptNo: number): Timing | undefined {
  return policy.scheduleEntry(code, attemptNo)?.timing;
}
