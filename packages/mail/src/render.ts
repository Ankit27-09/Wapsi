import { formatINR, type Paise } from '@rc/core';

/**
 * The recovery email, in the console's own palette, carrying the arithmetic that justified it.
 *
 * WHY THE WORKING IS IN THE BODY. Every recovery email in existence says "your payment failed,
 * here is a link". This one also says why it exists: the probability that was looked up, the
 * value at stake, what the message cost, and the net against the floor it had to clear. A
 * customer who wants to know why they were contacted can read it, and so can a regulator.
 * The system's claim is that every action carries its arithmetic; an outreach channel that
 * dropped it on the way out would be the one place that claim stopped being true.
 *
 * WHY IT IS DARK, AND WHAT THAT COSTS. The palette is lifted token-for-token from
 * `apps/web/app/globals.css`, so an email opened straight after the console reads as the same
 * product rather than a generic notification. Dark HTML mail is genuinely riskier than light:
 * some mobile Gmail builds invert colours in dark mode, Outlook renders through Word's HTML
 * engine, and a few clients force a light ground. Every defence below exists for one of those:
 *
 *   - `color-scheme` and `supported-color-schemes` ask clients not to re-tint the page.
 *   - `bgcolor` sits beside every CSS `background`, because Word's engine reads the attribute.
 *   - Every text node states its own colour. Nothing inherits, so a client that drops one
 *     rule cannot leave dark text on a dark ground.
 *   - The page ground is painted on `body` AND on a full-width wrapper table, since clients
 *     that strip `<body>` styling are common.
 *
 * TABLES AND INLINE STYLES THROUGHOUT, which is ugly and correct. Gmail strips `<style>`
 * blocks in several contexts and neither it nor Outlook supports flexbox, grid or custom
 * properties. Widths are fixed, layout is nested tables, and it survives being rendered by
 * software from 2007.
 *
 * ONE HONEST COMPROMISE: the console sets Plus Jakarta Sans and JetBrains Mono through
 * `next/font`, and no mail client will load a web font from a `<link>` — Gmail removes it. The
 * stacks below are the closest system equivalents, so the type is near rather than identical.
 */

// ---------------------------------------------------------------------------
// The console's tokens, verbatim from globals.css
// ---------------------------------------------------------------------------
const BG = '#060a12'; // --bg          the page ground
const SURFACE = '#0c1420'; // --surface     the card
const PANEL = '#121d2c'; // --surface-2   the arithmetic panel
const LINE = '#1c2a3c'; // --border
const LINE_LIT = '#2a3d55'; // --border-lit

const INK = '#eaf2fb'; // --ink
const INK_BRIGHT = '#f6fafe'; // --ink-bright
const INK_DIM = '#c2cfe0'; // --ink-dim
const INK_FAINT = '#94a5bd'; // --ink-faint

const ACCENT = '#22d3ee'; // --accent
const ACCENT_LIT = '#67e8f9'; // --accent-lit
const ACCENT_DEEP = '#0891b2'; // --accent-deep

const GOOD = '#34d399'; // --good
const WARN = '#fbbf24'; // --warn

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Noto Sans',sans-serif";
const MONO =
  "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

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

/** `<`, `&` and friends, so a template or a cause can never break the markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** `checkout_abandonment` → `checkout abandonment`. Codes are for operators, not customers. */
const humanise = (code: string): string => code.replace(/_/g, ' ');

export function subjectFor(input: DispatchInput): string {
  return `Payment of ${formatINR(input.amount)} could not be completed`;
}

/**
 * The plain-text alternative.
 *
 * Not a courtesy. A multipart message without one scores worse in every spam filter, and a
 * client that blocks HTML would otherwise show an empty email at the moment it matters most.
 * Columns are padded so the arithmetic still lines up in a monospaced reader.
 */
export function textFor(input: DispatchInput): string {
  const pad = (label: string, value: string): string =>
    `  ${label.padEnd(34)}${value.padStart(13)}`;

  return [
    subjectFor(input),
    '',
    `  ${humanise(input.reasonCode)} · ${humanise(input.riskClass)} · attempt ${input.attemptNo}`,
    '',
    `  ${input.message}`,
    '',
    input.paymentUrl === null
      ? '  No payment link has been issued for this decision yet.'
      : `  Pay here:  ${input.paymentUrl}`,
    '',
    '  ─── WHY YOU RECEIVED THIS ───────────────────────────',
    '',
    '  This was not sent on a schedule. It had to clear an',
    '  expected-value gate first, with these numbers.',
    '',
    pad('probability of recovery', pct(input.pBps)),
    pad('value at stake (amount × margin)', formatINR(input.value)),
    pad('cost to send', formatINR(input.cost)),
    `  ${'─'.repeat(47)}`,
    pad('expected net', formatINR(input.net)),
    pad(`the floor it had to clear`, formatINR(input.floor)),
    '',
    `  Wapsi refused ${input.refusedInBatch} of ${input.decisionsInBatch} decisions in this batch.`,
    '  This one cleared the gate.',
    '',
    '  ─── PROVENANCE ──────────────────────────────────────',
    '',
    `  template   ${input.templateId}`,
    `  DLT id     ${input.dltTemplateId ?? '—'}`,
    `  decision   ${input.decisionId}`,
    '',
    '  Simulated population, test-mode payment link.',
    '  No real customer was contacted.',
    '',
    '  Wapsi · वापसी, the return · Razorpay AI Buildathon 2026',
  ].join('\n');
}

export function htmlFor(input: DispatchInput): string {
  // One row of the arithmetic table. Label in sans on the left, figure in tabular mono on the
  // right, so the decimal points line up the way they do in the console.
  const row = (label: string, value: string, opts: { emphasis?: boolean } = {}): string => `
              <tr>
                <td style="padding:8px 0;font-family:${SANS};font-size:13px;line-height:1.4;color:${INK_DIM};">${esc(label)}</td>
                <td align="right" style="padding:8px 0;font-family:${MONO};font-size:13px;line-height:1.4;font-weight:${opts.emphasis === true ? '600' : '400'};color:${opts.emphasis === true ? GOOD : INK};white-space:nowrap;">${esc(value)}</td>
              </tr>`;

  // A table-cell button rather than a styled anchor: Word's engine ignores padding on inline
  // elements, so an `<a>` with padding collapses to bare text in Outlook.
  const button =
    input.paymentUrl === null
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
           <td bgcolor="${PANEL}" style="background:${PANEL};border:1px solid ${LINE_LIT};border-radius:8px;padding:13px 18px;">
             <span style="font-family:${SANS};font-size:13px;line-height:1.4;color:${WARN};">No payment link has been issued for this decision yet.</span>
           </td></tr></table>`
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
           <td bgcolor="${ACCENT_DEEP}" style="background:${ACCENT_DEEP};border-radius:999px;">
             <a href="${esc(input.paymentUrl)}"
                style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:15px;
                       font-weight:600;line-height:1;color:${BG};text-decoration:none;">Complete your payment &rarr;</a>
           </td></tr></table>
         <div style="margin-top:12px;font-family:${MONO};font-size:11px;line-height:1.5;color:${INK_FAINT};word-break:break-all;">${esc(input.paymentUrl)}</div>`;

  return `<!doctype html>
<html lang="en" style="background:${BG};">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Asks the client not to re-tint a page that is already dark. Without these, some mobile
     Gmail builds invert the whole thing and the cyan lands on white. -->
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(subjectFor(input))}</title>
</head>
<body style="margin:0;padding:0;background:${BG};color:${INK};-webkit-font-smoothing:antialiased;">

<!-- The ground is painted twice on purpose: clients that strip body styling are common. -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG}" style="background:${BG};margin:0;padding:0;">
<tr><td align="center" style="padding:34px 14px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
         bgcolor="${SURFACE}"
         style="width:600px;max-width:100%;background:${SURFACE};border:1px solid ${LINE};border-radius:14px;">

    <!-- ── masthead ─────────────────────────────────────────────────── -->
    <tr><td style="padding:20px 30px;border-bottom:1px solid ${LINE};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:9px;font-family:${SANS};font-size:17px;line-height:1;color:${ACCENT};">&#9678;</td>
        <td style="font-family:${SANS};font-size:16px;font-weight:700;line-height:1;letter-spacing:-.02em;color:${INK_BRIGHT};">Wapsi</td>
        <td style="padding-left:11px;font-family:${SANS};font-size:12px;line-height:1;color:${INK_FAINT};">वापसी, the return</td>
      </tr></table>
    </td></tr>

    <!-- ── the headline: amount first, because it is the only thing read at a glance ── -->
    <tr><td style="padding:30px 30px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;"><tr>
        <td bgcolor="${PANEL}" style="background:${PANEL};border:1px solid ${LINE_LIT};border-radius:999px;padding:5px 13px;">
          <span style="font-family:${MONO};font-size:10px;line-height:1;letter-spacing:.12em;text-transform:uppercase;color:${WARN};">Payment incomplete</span>
        </td>
      </tr></table>

      <div style="font-family:${MONO};font-size:32px;line-height:1.15;font-weight:500;letter-spacing:-.03em;color:${ACCENT};">${esc(formatINR(input.amount))}</div>
      <div style="margin-top:6px;font-family:${SANS};font-size:17px;line-height:1.35;font-weight:600;color:${INK_BRIGHT};">could not be completed</div>
      <div style="margin-top:12px;font-family:${MONO};font-size:11.5px;line-height:1.5;color:${INK_FAINT};">
        ${esc(humanise(input.reasonCode))} &nbsp;·&nbsp; ${esc(humanise(input.riskClass))} &nbsp;·&nbsp; attempt ${input.attemptNo}
      </div>
    </td></tr>

    <!-- ── the message the engine's template produced ─────────────────── -->
    <tr><td style="padding:26px 30px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="border-left:2px solid ${ACCENT};padding:2px 0 2px 15px;">
          <span style="font-family:${SANS};font-size:15px;line-height:1.65;color:${INK};">${esc(input.message)}</span>
        </td>
      </tr></table>
    </td></tr>

    <!-- ── the link ──────────────────────────────────────────────────── -->
    <tr><td style="padding:26px 30px 30px;">${button}</td></tr>

    <!-- ── the working ───────────────────────────────────────────────── -->
    <tr><td bgcolor="${PANEL}" style="background:${PANEL};padding:22px 30px;border-top:1px solid ${LINE};">
      <div style="font-family:${SANS};font-size:10.5px;font-weight:700;line-height:1;letter-spacing:.13em;text-transform:uppercase;color:${ACCENT_LIT};">Why you received this</div>
      <div style="margin-top:9px;font-family:${SANS};font-size:12.5px;line-height:1.6;color:${INK_DIM};">
        This was not sent on a schedule. It had to clear an expected-value gate first, and
        these are the numbers it cleared it with.
      </div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
        ${row('probability of recovery', pct(input.pBps))}
        ${row('value at stake (amount × margin)', formatINR(input.value))}
        ${row('cost to send', formatINR(input.cost))}
        <tr><td colspan="2" style="padding:0;"><div style="height:1px;background:${LINE_LIT};font-size:0;line-height:0;">&nbsp;</div></td></tr>
        ${row('expected net', formatINR(input.net), { emphasis: true })}
        ${row('the floor it had to clear', formatINR(input.floor))}
      </table>

      <div style="margin-top:16px;padding-top:15px;border-top:1px solid ${LINE};font-family:${SANS};font-size:12.5px;line-height:1.6;color:${INK_DIM};">
        Wapsi refused <span style="font-family:${MONO};font-weight:600;color:${INK_BRIGHT};">${input.refusedInBatch} of ${input.decisionsInBatch}</span>
        decisions in this batch. This one cleared the gate.
      </div>
    </td></tr>

    <!-- ── provenance ────────────────────────────────────────────────── -->
    <tr><td style="padding:22px 30px 26px;border-top:1px solid ${LINE};">
      <div style="font-family:${SANS};font-size:10.5px;font-weight:700;line-height:1;letter-spacing:.13em;text-transform:uppercase;color:${INK_FAINT};">Provenance</div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:11px;">
        <tr>
          <td width="86" style="padding:4px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${INK_FAINT};">template</td>
          <td style="padding:4px 0;font-family:${MONO};font-size:11.5px;line-height:1.5;color:${INK_DIM};">${esc(input.templateId)}</td>
        </tr>
        <tr>
          <td width="86" style="padding:4px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${INK_FAINT};">DLT id</td>
          <td style="padding:4px 0;font-family:${MONO};font-size:11.5px;line-height:1.5;color:${INK_DIM};">${esc(input.dltTemplateId ?? '—')}</td>
        </tr>
        <tr>
          <td width="86" style="padding:4px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${INK_FAINT};">decision</td>
          <td style="padding:4px 0;font-family:${MONO};font-size:11.5px;line-height:1.5;color:${INK_DIM};word-break:break-all;">${esc(input.decisionId)}</td>
        </tr>
      </table>

      <div style="margin-top:14px;font-family:${SANS};font-size:12px;line-height:1.6;color:${INK_FAINT};">
        The model fills declared variables inside a DLT-registered body; it does not write the
        text that reaches you. Simulated population and a test-mode payment link &mdash; no real
        customer was contacted.
      </div>
    </td></tr>

  </table>

  <div style="margin-top:18px;font-family:${SANS};font-size:11px;line-height:1.5;color:${INK_FAINT};">
    Razorpay AI Buildathon 2026 &nbsp;·&nbsp; Track 03
  </div>

</td></tr></table>
</body></html>`;
}
