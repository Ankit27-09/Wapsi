import { formatINR, type Paise } from '@rc/core';

/**
 * The recovery email, and the arithmetic that justified sending it.
 *
 * WHY THE WORKING IS IN THE BODY. Every recovery email in existence says "your payment failed,
 * here is a link". This one also says why it exists: the probability that was looked up, the
 * value at stake, what the message cost, and the net against the floor it had to clear. A
 * customer who wants to know why they were contacted can read it, and so can a regulator.
 *
 * That is not decoration on a demo. The whole system's claim is that every action carries its
 * arithmetic; an outreach channel that dropped the arithmetic on the way out would be the one
 * place the claim stopped being true.
 *
 * BUILT AS TABLES WITH INLINE STYLES, which is ugly and correct. Gmail strips `<style>`
 * blocks in some contexts, Outlook renders through Word's HTML engine, and neither supports
 * flexbox or CSS custom properties. Every rule that matters is inline on the element it
 * affects, widths are fixed, and the layout survives being rendered by 2007.
 */

export interface DispatchInput {
  /** Rendered from a DLT-registered template by the engine. Never composed here. */
  readonly message: string;
  readonly templateId: string;
  readonly dltTemplateId: string | null;
  readonly amount: Paise;
  readonly reasonCode: string;
  readonly riskClass: string;
  readonly attemptNo: number;
  /** The live Razorpay link, already issued. Null when none exists yet. */
  readonly paymentUrl: string | null;
  readonly decisionId: string;

  /** The gate's own numbers, as recorded on the decision. */
  readonly pBps: number;
  readonly value: Paise;
  readonly cost: Paise;
  readonly net: Paise;
  readonly floor: Paise;

  /** Batch context, so a single email carries the scale of the restraint around it. */
  readonly refusedInBatch: number;
  readonly decisionsInBatch: number;
}

const INK = '#131820';
const INK_DIM = '#5b6673';
const LINE = '#dfe4ea';
const ACCENT = '#0e7490';
const GROUND = '#f4f6f8';
const GOOD = '#12694a';

/** `<`, `&` and friends, so a template or a cause can never break the markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

export function subjectFor(input: DispatchInput): string {
  return `Payment of ${formatINR(input.amount)} could not be completed`;
}

/**
 * The plain-text alternative.
 *
 * Not a courtesy. A multipart message without a text part scores worse in every spam filter,
 * and a judge whose client blocks HTML would otherwise receive an empty email at the moment
 * it matters most.
 */
export function textFor(input: DispatchInput): string {
  const link = input.paymentUrl ?? '(no payment link issued yet)';
  return [
    subjectFor(input),
    '',
    input.message,
    '',
    `Pay here: ${link}`,
    '',
    '--- Why you received this ---',
    `probability      ${pct(input.pBps)}`,
    `value at stake   ${formatINR(input.value)}`,
    `cost to send     ${formatINR(input.cost)}`,
    `expected net     ${formatINR(input.net)}  (floor ${formatINR(input.floor)})`,
    '',
    `cause            ${input.reasonCode} · ${input.riskClass} · attempt ${input.attemptNo}`,
    `template         ${input.templateId}${input.dltTemplateId === null ? '' : ` (DLT ${input.dltTemplateId})`}`,
    `decision         ${input.decisionId}`,
    '',
    `Wapsi refused ${input.refusedInBatch} of ${input.decisionsInBatch} decisions in this`,
    'batch. This one cleared the gate.',
    '',
    'Simulated population, test-mode payment link. No real customer was contacted.',
  ].join('\n');
}

export function htmlFor(input: DispatchInput): string {
  const row = (label: string, value: string, bold = false): string => `
        <tr>
          <td style="padding:7px 0;font:13px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK_DIM};">${esc(label)}</td>
          <td align="right" style="padding:7px 0;font:${bold ? '600 ' : ''}13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${bold ? GOOD : INK};white-space:nowrap;">${esc(value)}</td>
        </tr>`;

  const button =
    input.paymentUrl === null
      ? `<p style="margin:0;font:13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK_DIM};">
           No payment link has been issued for this decision yet.
         </p>`
      : `<a href="${esc(input.paymentUrl)}"
              style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;
                     font:600 15px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
                     padding:14px 26px;border-radius:6px;">Complete your payment</a>
         <p style="margin:12px 0 0;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${INK_DIM};word-break:break-all;">${esc(input.paymentUrl)}</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subjectFor(input))}</title></head>
<body style="margin:0;padding:0;background:${GROUND};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
<tr><td align="center" style="padding:32px 14px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
         style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:10px;">

    <!-- masthead -->
    <tr><td style="padding:22px 30px 18px;border-bottom:1px solid ${LINE};">
      <span style="font:700 17px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};letter-spacing:-.02em;">Wapsi</span>
      <span style="font:13px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK_DIM};"> &nbsp;·&nbsp; वापसी, the return</span>
    </td></tr>

    <!-- the message the engine produced -->
    <tr><td style="padding:28px 30px 6px;">
      <p style="margin:0 0 6px;font:600 20px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};">
        Payment of ${esc(formatINR(input.amount))} could not be completed
      </p>
      <p style="margin:0 0 20px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${INK_DIM};">
        ${esc(input.reasonCode)} &nbsp;·&nbsp; ${esc(input.riskClass)} &nbsp;·&nbsp; attempt ${input.attemptNo}
      </p>
      <p style="margin:0 0 24px;font:15px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};">
        ${esc(input.message)}
      </p>
    </td></tr>

    <!-- the link -->
    <tr><td style="padding:0 30px 28px;">${button}</td></tr>

    <!-- the working -->
    <tr><td style="padding:20px 30px;background:${GROUND};border-top:1px solid ${LINE};">
      <p style="margin:0 0 4px;font:600 11px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};letter-spacing:.1em;text-transform:uppercase;">
        Why you received this
      </p>
      <p style="margin:0 0 14px;font:12px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK_DIM};">
        This message was not sent on a schedule. It had to clear an expected-value gate first,
        and these are the numbers it cleared it with.
      </p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${row('probability of recovery', pct(input.pBps))}
        ${row('value at stake (amount × margin)', formatINR(input.value))}
        ${row('cost to send', formatINR(input.cost))}
        <tr><td colspan="2" style="border-top:1px solid ${LINE};height:1px;line-height:1px;">&nbsp;</td></tr>
        ${row(`expected net · floor is ${formatINR(input.floor)}`, formatINR(input.net), true)}
      </table>
    </td></tr>

    <!-- provenance -->
    <tr><td style="padding:18px 30px 24px;border-top:1px solid ${LINE};">
      <p style="margin:0 0 10px;font:12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK_DIM};">
        Sent from template
        <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${INK};">${esc(input.templateId)}</span>${
          input.dltTemplateId === null
            ? ''
            : `, DLT-registered as <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${INK};">${esc(input.dltTemplateId)}</span>`
        }. The model fills declared variables inside an approved body; it does not write the
        text that reaches you.
      </p>
      <p style="margin:0 0 10px;font:12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK_DIM};">
        Wapsi refused <b style="color:${INK};">${input.refusedInBatch} of ${input.decisionsInBatch}</b>
        decisions in this batch. This one cleared the gate.
      </p>
      <p style="margin:0;font:11px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK_DIM};">
        Simulated population and a test-mode payment link — no real customer was contacted.
        Decision <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${esc(input.decisionId)}</span>
      </p>
    </td></tr>

  </table>

  <p style="margin:16px 0 0;font:11px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK_DIM};">
    Razorpay AI Buildathon 2026 · Track 03
  </p>

</td></tr></table></body></html>`;
}
