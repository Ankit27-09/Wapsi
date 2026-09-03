import { z } from 'zod';
import { REASON_CODES, ZERO, bpsFromUnit, type Bps, type Paise } from '@rc/core';
import { modelCallCost } from './cost.js';
import { readJson, type Provider } from './providers.js';

/**
 * THE POLICY-PROPOSAL AGENT
 *
 * After a batch completes, the agent reads what happened and proposes a change to the
 * policy. A human approves or rejects. Approved changes increment the policy version and
 * are then evaluated on a HELD-OUT seed, so an improvement has to generalise rather than
 * fit the batch it was learned from.
 *
 * THE SAFETY PROPERTY IS THE SCHEMA, NOT THE PROMPT.
 *
 * The agent cannot propose relaxing the kill switch, widening quiet hours, raising the
 * contact ceiling, weakening consent, or enlarging the fee budget — not because it is asked
 * not to, but because THERE IS NO FIELD IN WHICH TO SAY IT. `TUNABLE_FIELDS` below is the
 * complete vocabulary of the proposal type; a model that emitted
 * `{"field": "kill_switch"}` would fail enum validation and be rejected before any human
 * saw it.
 *
 * That distinction is the whole argument. A prompt saying "never touch the safety bounds"
 * is a request. A schema without those fields is a guarantee, and it holds under prompt
 * injection, model error, and a future contributor who did not read the comment.
 *
 * Ranges are re-checked on the way in as well. A guarantee that exists in exactly one layer
 * is a guarantee that survives exactly one refactor.
 */

/**
 * Every field the agent may propose changing. The complete list.
 *
 * `min_gap_hours` — how long to wait before re-presenting a given failure class.
 * `ev_floor_paise` — the expected-value threshold below which nothing fires.
 *
 * Both are TUNING parameters: getting them wrong costs money or forgoes it. Neither can
 * make the system unsafe, which is precisely why they are the two that are delegable.
 */
export const TUNABLE_FIELDS = ['min_gap_hours', 'ev_floor_paise'] as const;
export type TunableField = (typeof TUNABLE_FIELDS)[number];

const ProposedChangeSchema = z
  .object({
    field: z.enum(TUNABLE_FIELDS),
    /**
     * Which reason code this applies to. Null for the global expected-value floor, which is
     * not per-code.
     *
     * `.default(null)` rather than plain `.nullable()`, and the difference is not cosmetic.
     * A nullable-but-REQUIRED field means a global change has to send `reason_code: null`
     * explicitly, and the model sends it most of the time — which is the worst frequency for
     * a required key. One run produced three good changes; the next was discarded whole with
     * `changes.2.reason_code Required`, because the model omitted a key whose only possible
     * value there is null. Losing an entire proposal over that is not strictness, it is
     * brittleness: there is no second reading of a missing reason code on a global field.
     *
     * The coherence it was implicitly buying is now enforced properly, below.
     */
    reason_code: z.enum(REASON_CODES).nullable().default(null),
    from_value: z.number().int(),
    to_value: z.number().int(),
    rationale: z.string().min(20),
    /** Decision ids the agent relied on. Makes the reasoning checkable rather than trusted. */
    evidence_decision_ids: z.array(z.string()).max(8),
  })
  .refine((change) => (change.field === 'ev_floor_paise') === (change.reason_code === null), {
    message:
      'ev_floor_paise is global and must carry no reason code; min_gap_hours is per-code and ' +
      'must carry one. A per-code change with no code cannot be applied to anything.',
    path: ['reason_code'],
  });

export const ProposalSchema = z.object({
  changes: z.array(ProposedChangeSchema).min(1).max(3),
  predicted_net_delta_paise: z.number().int(),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(20),
});

export type ProposedChange = z.infer<typeof ProposedChangeSchema>;
export type ParsedProposal = z.infer<typeof ProposalSchema>;

/**
 * The same shape as JSON Schema, for the API's structured-output constraint.
 *
 * The `enum` on `field` is the mechanism described above: it is what makes the safety bounds
 * unreachable at the point of generation, not merely rejected afterwards.
 */
const PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: TUNABLE_FIELDS },
          reason_code: { type: ['string', 'null'], enum: [...REASON_CODES, null] },
          from_value: { type: 'integer' },
          to_value: { type: 'integer' },
          rationale: {
            type: 'string',
            description: 'Why, citing what actually happened in the batch.',
          },
          evidence_decision_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8,
            description: 'Decision ids supporting the change.',
          },
        },
        required: [
          'field',
          'reason_code',
          'from_value',
          'to_value',
          'rationale',
          'evidence_decision_ids',
        ],
        additionalProperties: false,
      },
    },
    predicted_net_delta_paise: {
      type: 'integer',
      description: 'Expected change in net value across a batch of this size, in paise.',
    },
    confidence: { type: 'number', description: 'Calibrated probability the change helps.' },
    summary: { type: 'string' },
  },
  required: ['changes', 'predicted_net_delta_paise', 'confidence', 'summary'],
  additionalProperties: false,
} as const;

export interface ProposalEvidence {
  readonly policyVersion: number;
  /** A compact rendering of what happened, assembled by the caller from the audit trail. */
  readonly batchSummary: string;
  /** Current values and permitted ranges, so the agent proposes inside the clamps. */
  readonly tunables: readonly {
    readonly field: TunableField;
    readonly reasonCode: string | null;
    readonly current: number;
    readonly min: number;
    readonly max: number;
  }[];
}

export interface ProposalResult {
  readonly proposal: ParsedProposal | null;
  readonly error: string | null;
  readonly model: string;
  readonly costPaise: Paise;
  readonly confidenceBps: Bps;
  readonly latencyMs: number;
}

export interface ProposerOptions {
  /** The provider to call. Built by `resolveProvider` from the environment. */
  readonly provider: Provider;
  readonly usdInrPaise: number;
}

const SYSTEM_PROMPT = [
  'You tune the retry policy of a payment recovery system by reading what a completed',
  'batch actually did and proposing small, evidence-backed parameter changes.',
  '',
  'WHAT YOU MAY CHANGE',
  '',
  'Only two parameters, and they are the only ones the output format can express:',
  '',
  '  min_gap_hours   How long to wait before re-presenting a given failure class.',
  '  ev_floor_paise  The expected-value threshold below which no action fires.',
  '',
  'You cannot propose changes to the kill switch, quiet hours, contact ceilings, consent',
  'rules, or the fee budget. Those are safety bounds, they are not in your output format,',
  'and a human owns them. Do not describe such changes in your rationale either — a',
  'recommendation nobody can action is noise in a queue somebody has to read.',
  '',
  'HOW TO REASON',
  '',
  '- Every change must cite what happened. "Attempt 2 on insufficient_funds was refused 41',
  '  times for min_gap with a 48h requirement, and the 9 that did fire recovered 6" is a',
  '  reason. "Retries could be more aggressive" is not.',
  '- Propose at most three changes. A tuning pass that rewrites the policy is not a tuning',
  '  pass, and a human has to be able to evaluate each one.',
  '- Stay inside the stated ranges. A proposal outside them is discarded before review.',
  '- predicted_net_delta_paise is your estimate for a batch of the size described. Being',
  '  wrong is acceptable and is measured against a held-out run; being unfalsifiable is not.',
  '- confidence is your calibrated probability that the change improves net value. A',
  '  well-placed 0.5 is more useful than a reflexive 0.9, because a human uses it to decide',
  '  how hard to look.',
  '- If the evidence does not support any change, say so in the summary and propose the',
  '  smallest defensible one. Do not invent a finding to fill the quota.',
].join('\n');

export function createProposer(options: ProposerOptions): {
  propose(evidence: ProposalEvidence): Promise<ProposalResult>;
} {
  const { provider } = options;
  const label = `${provider.id}:${provider.model}`;

  return {
    async propose(evidence: ProposalEvidence): Promise<ProposalResult> {
      const started = performance.now();

      const ranges = evidence.tunables
        .map(
          (tunable) =>
            `  ${tunable.field}${tunable.reasonCode === null ? '' : ` (${tunable.reasonCode})`}` +
            `: currently ${tunable.current}, permitted ${tunable.min}–${tunable.max}`,
        )
        .join('\n');

      try {
        const response = await provider.complete({
          systemPrompt: SYSTEM_PROMPT,
          userMessage: [
            `Policy version ${evidence.policyVersion}.`,
            '',
            'TUNABLE PARAMETERS',
            ranges,
            '',
            'WHAT THE BATCH DID',
            evidence.batchSummary,
            '',
            'Reply with a single JSON object and nothing else:',
            JSON.stringify(PROPOSAL_JSON_SCHEMA),
          ].join('\n'),
          // Generous, and it has to be. Some tiers emit reasoning tokens that count against
          // this cap — at 4096 the reasoning consumed the budget and the JSON came back
          // truncated mid-string, which surfaces as a parse failure rather than as anything
          // that says "out of room".
          maxTokens: 16_000,
        });

        const cost = modelCallCost(
          provider.model,
          {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cacheReadTokens: response.usage.cacheReadTokens,
            cacheWriteTokens: response.usage.cacheWriteTokens,
          },
          options.usdInrPaise,
        );

        const parsed = ProposalSchema.safeParse(readJson(response.text));
        if (!parsed.success) {
          return {
            proposal: null,
            error: `Proposal failed validation: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.')} ${issue.message}`)
              .join('; ')}`,
            model: label,
            costPaise: cost,
            confidenceBps: bpsFromUnit(0),
            latencyMs: Math.round(performance.now() - started),
          };
        }

        return {
          proposal: parsed.data,
          error: null,
          model: label,
          costPaise: cost,
          confidenceBps: bpsFromUnit(parsed.data.confidence),
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        return {
          proposal: null,
          error: error instanceof Error ? error.message : String(error),
          model: label,
          costPaise: ZERO,
          confidenceBps: bpsFromUnit(0),
          latencyMs: Math.round(performance.now() - started),
        };
      }
    },
  };
}

/**
 * Re-check a proposed change against the policy's clamps.
 *
 * The schema already prevents an unsafe FIELD; this prevents an out-of-range VALUE. Both
 * checks exist in the policy loader too — deliberately, because a guarantee that lives in
 * one layer survives exactly one refactor.
 */
export function changeIsInRange(
  change: ProposedChange,
  range: { readonly min: number; readonly max: number } | undefined,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (range === undefined) {
    return { ok: false, reason: `${change.field} is not a tunable field in this policy` };
  }
  if (change.to_value < range.min || change.to_value > range.max) {
    return {
      ok: false,
      reason: `${change.to_value} is outside the permitted range ${range.min}–${range.max}`,
    };
  }
  if (change.to_value === change.from_value) {
    return { ok: false, reason: 'proposes no actual change' };
  }
  return { ok: true };
}
