import { ZERO, bps, type Bps, type ReasonCode } from '@rc/core';
import type { Classification, ClassificationInput, Classifier } from './classifier.js';

/**
 * THE KEYWORD BASELINE — ablation arm A0
 *
 * What a competent engineer writes on a Friday afternoon when asked to route failed
 * payments by cause. It is the thing the LLM has to beat, and the whole ablation is
 * worthless if it is a strawman.
 *
 * ON THE CIRCULARITY RISK, because it is real and worth stating plainly.
 *
 * The same repository contains the failure strings this classifier is scored against. It
 * would be trivial — and dishonest — to read that pool and add one rule per entry, which
 * would produce a baseline that scores near-perfectly and an ablation showing the LLM adds
 * nothing. It would be equally dishonest to write a deliberately feeble table and claim a
 * large LLM uplift.
 *
 * So the rules below are written from PAYMENTS DOMAIN KNOWLEDGE and nothing else: the real
 * ISO 8583 response codes, and the vocabulary gateways actually use. No rule here was added
 * by consulting `simulator/src/strings.ts`. The consequences are visible and expected — it
 * handles bare numeric codes and plain English well, and it fails on transliterated
 * Hinglish, on vendor-specific mnemonics, on genuinely novel strings, and on the opaque
 * tier where the cause is simply absent from the text. Those failures are the measurement.
 *
 * ISO 8583 codes used below are the real ones. Recognising a bare `05` is the sort of thing
 * a payments engineer does instantly, so a fair baseline gets to do it too.
 *
 * The table covers checkout abandonment and overdue receivables as well as payment declines,
 * because the system does — and a baseline that had no rules for two thirds of the taxonomy
 * would be the strawman this file exists to avoid. Those rules come from the vocabulary
 * checkout analytics and accounts-receivable teams actually use, and they are deliberately
 * conservative: each requires an unambiguous domain signal, so a string that reads like a
 * payment decline is still handled by the payments rules.
 */

/**
 * Confidence tiers.
 *
 * A numeric response code is an unambiguous statement by the issuer, so it earns high
 * confidence. A keyword match is an inference from prose and earns less. The floor in
 * `llm.ts` is applied to both, so a weak keyword match quarantines rather than acting.
 */
const CONFIDENCE_ISO_CODE = bps(9_500);
const CONFIDENCE_STRONG_PHRASE = bps(8_500);
const CONFIDENCE_WEAK_KEYWORD = bps(6_500);

interface Rule {
  readonly pattern: RegExp;
  readonly code: ReasonCode;
  readonly confidence: Bps;
}

/**
 * Rules in priority order; first match wins.
 *
 * Ordering matters more than the individual patterns. "timeout" appears in both an
 * authentication abandonment and a transport failure, so the authentication-specific
 * signals must be tested first — otherwise every 3DS timeout is misfiled as a network
 * timeout, and the system responds by re-presenting the same challenge that just failed
 * instead of switching rail.
 */
const RULES: readonly Rule[] = [
  // =========================================================================
  // CHECKOUT FUNNEL AND RECEIVABLES
  //
  // Placed FIRST, and only because these patterns require an unambiguous
  // domain signal — a funnel-exit token, or accounts-receivable vocabulary.
  // Anything that could also be a payment decline is left to the payments
  // rules below.
  //
  // Same discipline as the rest of the file: written from the vocabulary these
  // systems actually emit, not from the simulator's string pool. Checkout
  // analytics speak in funnel steps (`funnel_exit`, `step=`, `session
  // expired`); receivables teams speak in `AP hold`, `payment run`, `PTP`,
  // `short paid` — all standard terms in those trades.
  // =========================================================================

  // ---- receivables: the blocker is a process, and the process is named ----
  // Approval before dispute, because an invoice can be both queried AND awaiting an
  // approver, and the approver is the actionable half.
  { pattern: /\bap[ _-]?hold\b|awaiting[ _-]?(?:approval|approver)|pending[ _-]approval|approval[ _-]?(?:chain|workflow|queue)|with the approver|sign[ _-]?off/i, code: 'awaiting_approval', confidence: CONFIDENCE_STRONG_PHRASE },
  { pattern: /\bptp\b|promise[ _-]?to[ _-]?pay|promised[ _-](?:date|payment|to pay)|committed to pay/i, code: 'promised_not_paid', confidence: CONFIDENCE_STRONG_PHRASE },
  { pattern: /disput|short[ _-]?paid|line[ _-]?item[ _-]?quer|billing[ _-]?quer|contested/i, code: 'disputed_line_item', confidence: CONFIDENCE_STRONG_PHRASE },
  { pattern: /payment[ _-]?run|remittance[ _-]?(?:run|cycle)|payment[ _-]?cycle|missed the run|next run|cut[ _-]?off/i, code: 'payment_run_cycle', confidence: CONFIDENCE_STRONG_PHRASE },

  // `no_response` lives further down, AFTER the payments rules. It matched "bank server not
  // responding" and filed an issuer outage as a collections problem — the rule is the
  // broadest in the file and it has to be the last thing tried, not among the first.

  // ---- checkout: the funnel step is the signal ----------------------------
  // Each of these needs BOTH a stage word and an abandonment word, because the stage words
  // alone are ambiguous. "otp" in particular is a payments term first: an OTP failure during
  // an authorisation is a 3DS timeout, and only an OTP exit during checkout is an
  // abandonment. Requiring the abandonment token keeps that distinction honest, and it means
  // this rule genuinely misses strings that mention only `acs` and `otp` — a failure the
  // ablation should show rather than one to engineer away.
  { pattern: /(?=.*(?:abandon|funnel[ _-]?exit|drop[ _-]?off|dropped|left|exit|session[ _-]?(?:end|ended|expired)|not[ _-]?entered|did not (?:complete|enter)))(?=.*\botp\b)/i, code: 'abandoned_at_otp', confidence: CONFIDENCE_STRONG_PHRASE },
  { pattern: /(?=.*(?:abandon|funnel[ _-]?exit|drop[ _-]?off|dropped|left|exit|session[ _-]?(?:end|ended|expired)|did not (?:choose|complete|finish|enter)|incomplete))(?=.*(?:payment[ _-]?(?:method|selection|page)|method[ _-]?select))/i, code: 'abandoned_at_payment', confidence: CONFIDENCE_STRONG_PHRASE },
  { pattern: /(?=.*(?:abandon|funnel[ _-]?exit|drop[ _-]?off|dropped|left|exit|session[ _-]?(?:end|ended|expired)|did not (?:choose|complete|finish|enter)|incomplete))(?=.*(?:address|shipping|delivery|pincode))/i, code: 'abandoned_at_address', confidence: CONFIDENCE_STRONG_PHRASE },
  { pattern: /(?=.*(?:abandon|funnel[ _-]?exit|drop[ _-]?off|dropped|left|exit|session[ _-]?(?:end|ended|expired)|did not (?:choose|complete|finish|enter)|incomplete))(?=.*(?:cart|basket|bag))/i, code: 'abandoned_at_cart', confidence: CONFIDENCE_STRONG_PHRASE },

  // ---- ISO 8583 response codes, as standalone tokens ----------------------
  // Anchored on word boundaries so an amount or a reference number containing "51"
  // cannot be read as a decline code.
  { pattern: /(?:^|[^\d])51(?:[^\d]|$)/, code: 'insufficient_funds', confidence: CONFIDENCE_ISO_CODE },
  { pattern: /(?:^|[^\d])05(?:[^\d]|$)/, code: 'do_not_honour', confidence: CONFIDENCE_ISO_CODE },
  { pattern: /(?:^|[^\d])54(?:[^\d]|$)/, code: 'card_expired', confidence: CONFIDENCE_ISO_CODE },
  { pattern: /(?:^|[^\d])59(?:[^\d]|$)/, code: 'suspected_fraud_block', confidence: CONFIDENCE_ISO_CODE },
  { pattern: /(?:^|[^\d])91(?:[^\d]|$)/, code: 'issuer_down', confidence: CONFIDENCE_ISO_CODE },

  // ---- risk, before anything that could look like a generic decline -------
  { pattern: /suspected fraud|risk[ _-]?(?:engine|block)|velocity|fraud/i, code: 'suspected_fraud_block', confidence: CONFIDENCE_STRONG_PHRASE },

  // ---- mandate, before "cancelled"/"revoked" can be read generically ------
  { pattern: /mandate|e-?mandate|\bumn\b|standing instruction|\bsi\b.*(?:cancel|revok)/i, code: 'mandate_expired', confidence: CONFIDENCE_STRONG_PHRASE },

  // ---- expiry ------------------------------------------------------------
  { pattern: /expired card|card (?:has )?expired|invalid expiry|expiry/i, code: 'card_expired', confidence: CONFIDENCE_STRONG_PHRASE },

  // ---- authentication, BEFORE the generic timeout rules -------------------
  { pattern: /3ds|three-?ds|\bacs\b|\botp\b|authentication|challenge|cardholder.*abandon/i, code: 'threeds_timeout', confidence: CONFIDENCE_STRONG_PHRASE },

  // ---- issuer availability ------------------------------------------------
  { pattern: /issuer (?:unavailable|inoperative)|bank server|switch inoperative|\b50[23]\b|iss[_ ]host/i, code: 'issuer_down', confidence: CONFIDENCE_STRONG_PHRASE },

  // ---- funds --------------------------------------------------------------
  { pattern: /insufficient|\bnsf\b|low balance|not enough balance|balance low/i, code: 'insufficient_funds', confidence: CONFIDENCE_STRONG_PHRASE },

  // ---- do not honour ------------------------------------------------------
  { pattern: /do not hono[u]?r|\bdnh\b|refused by issuing bank|bank[_ ]declined/i, code: 'do_not_honour', confidence: CONFIDENCE_STRONG_PHRASE },

  // ---- transport, last: the weakest and most ambiguous signal -------------
  { pattern: /gateway timeout|etimedout|connection reset|\b504\b|timed out|timeout/i, code: 'network_timeout', confidence: CONFIDENCE_WEAK_KEYWORD },

  // ---- receivables silence, dead last -------------------------------------
  // The broadest pattern in the file, so it goes after every payments rule. Placed among the
  // receivables block originally, where it read "bank server not responding" as a buyer who
  // would not reply and filed an issuer outage as a collections problem.
  { pattern: /no[ _-]?(?:response|reply|contact)|unreachable|not responding|chased.*no reply/i, code: 'no_response', confidence: CONFIDENCE_WEAK_KEYWORD },

  // ---- a bare "declined" says only that it failed -------------------------
  // Deliberately NOT mapped. It is the most tempting rule in the file and the most
  // harmful: it would convert every opaque string into a confident `do_not_honour`,
  // spending money on a cause nobody identified. Absence of a rule here is the rule.
];

/**
 * WHERE THIS TABLE FAILS ON PLAIN ENGLISH, measured rather than asserted.
 *
 * Three strings in the easy tier defeat it, and all three are worth keeping:
 *
 *   "customer did not complete OTP verification"          → read as an abandoned checkout
 *   "customer reached authentication and did not complete it" → read as a 3DS timeout
 *
 * A symmetric confusion between the same two causes, from the same words. Nothing in either
 * sentence says whether a charge was presented, and that is the entire difference: an OTP
 * failure during an authorisation needs a different rail, while an OTP exit during checkout
 * needs a fresh link. A rule table cannot tell them apart, and it is wrong in BOTH directions
 * — which costs money twice, since each cause's correct intervention is useless for the
 * other. Disambiguating it requires knowing what a charge is, not which words appeared.
 *
 *   "customer says the quantity on the invoice is wrong"  → unrecognised
 *
 * A dispute, stated without any of the vocabulary of disputes. Reachable only by adding a
 * rule for "quantity ... wrong", which is reading the corpus rather than knowing the domain.
 * Left failing on purpose: the honest ceiling of a keyword table is what the ablation is
 * measuring, and engineering this away would delete the measurement.
 */

export function classifyByKeyword(input: ClassificationInput): {
  readonly code: ReasonCode;
  readonly confidence: Bps;
} {
  // The gateway's structured code is checked first and on its own. When a gateway supplies
  // `51`, that is a better signal than anything in the prose beside it.
  const haystack = `${input.gatewayCode ?? ''} ${input.description}`;

  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) {
      return { code: rule.code, confidence: rule.confidence };
    }
  }

  return { code: 'unknown', confidence: bps(0) };
}

/**
 * The keyword classifier as an ablation arm.
 *
 * Free, instant, and deterministic — which is exactly why it is the right thing to measure
 * the model against. If it captures the same net value, the model does not belong in this
 * loop, and that finding goes in the report.
 */
export const KEYWORD_CLASSIFIER: Classifier = {
  method: 'keyword',
  model: null,

  classify(input: ClassificationInput): Promise<Classification> {
    const started = performance.now();
    const { code, confidence } = classifyByKeyword(input);

    return Promise.resolve({
      reasonCode: code,
      confidenceBps: confidence,
      method: 'keyword',
      quarantined: code === 'unknown',
      model: null,
      promptHash: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costPaise: ZERO,
      latencyMs: Math.round(performance.now() - started),
      error: null,
    });
  },
};
