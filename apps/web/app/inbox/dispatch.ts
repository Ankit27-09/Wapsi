'use server';

import { PaiseSchema, formatINR } from '@rc/core';
import { htmlFor, resolveMail, subjectFor, textFor, MailError } from '@rc/mail';
import { loadPolicy } from '@rc/policy';
import { findLinkByReference, readConfig, toReference, RazorpayError } from '@rc/razorpay';
import { db } from '../../lib/db';
import { renderSend } from '../../lib/script';

/**
 * Dispatch the message a decision produced, with its arithmetic, to the operator's address.
 *
 * THE CONSOLE DOES NOT CREATE THE PAYMENT LINK, and that boundary is the point of this file.
 *
 * It would be one line shorter to call `ensureLink` and have Razorpay issue one on demand. It
 * is also the line where a read-only operations console acquires the ability to demand money
 * from someone. `razorpay-client-decides-nothing` exists to keep decision-making away from
 * the payment path; letting the UI mint links for a nicer demo erodes it from the other side.
 *
 * So this LOOKS UP a link that already exists — `findLinkByReference`, read-only — and says
 * so plainly when none does. Three roles, none overlapping: the engine decided, `pnpm
 * razorpay --live` issued, this dispatches.
 *
 * WHY THE RECIPIENT IS ALWAYS THE OPERATOR. The engine has no email channel — zero registered
 * email templates, no email consent anywhere in the seeded book — so an email to a customer
 * would be a send the compliance layer refuses. `MAIL_TO` is read from the environment and
 * there is no path from a `customer` row to a recipient address. That is enforcement, not
 * documentation.
 */

export interface DispatchResult {
  readonly ok: boolean;
  readonly to: string | null;
  readonly messageId: string | null;
  readonly paymentUrl: string | null;
  readonly error: string | null;
  /** Set when the mail went out with no link, so the button can say why. */
  readonly warning: string | null;
}

const nothing = { to: null, messageId: null, paymentUrl: null, warning: null };

export async function dispatch(sendId: number): Promise<DispatchResult> {
  const mail = resolveMail();
  if (mail.provider === null) {
    return { ok: false, ...nothing, error: mail.problem ?? 'Email is not configured.' };
  }

  // AUTHORISED BY QUERY, not by trusting the argument. A caller cannot nominate an arbitrary
  // row: this only resolves for a FIRED `payment_link` decision, which is the one action
  // whose whole mechanism is a link the customer opens.
  const row = await db()
    .selectFrom('message_send')
    .innerJoin('decision', 'decision.id', 'message_send.decision_id')
    .innerJoin('txn', 'txn.id', 'decision.txn_id')
    .innerJoin('message_template', 'message_template.id', 'message_send.template_id')
    .select([
      'message_send.id as sendId',
      'message_send.template_id as templateId',
      'message_template.dlt_template_id as dltId',
      'decision.id as decisionId',
      'decision.idempotency_key as idempotencyKey',
      'decision.reason_code as reasonCode',
      'decision.attempt_no as attemptNo',
      'decision.ev_p_bps as pBps',
      'decision.ev_value_paise as value',
      'decision.ev_cost_paise as cost',
      'decision.ev_net_paise as net',
      'decision.batch_id as batchId',
      'txn.risk_class as riskClass',
      'txn.amount_paise as amount',
    ])
    .where('message_send.id', '=', sendId)
    .where('decision.verdict', '=', 'fire')
    .where('decision.planned_action', '=', 'payment_link')
    .executeTakeFirst();

  if (row === undefined) {
    return {
      ok: false,
      ...nothing,
      error:
        'That is not a fired payment_link decision. Dispatch is only available for the one ' +
        'action whose mechanism IS a link — 41 of them in this batch.',
    };
  }

  // The text the engine's template produces, through the same function the page displays and
  // the speech action speaks. One rendering path for all three.
  const script = await renderSend(sendId);
  if (script === null) {
    return { ok: false, ...nothing, error: 'That send has no renderable script.' };
  }

  // Batch context, so a single email carries the scale of the restraint around it.
  const verdicts = await db()
    .selectFrom('decision')
    .select(({ fn }) => ['verdict', fn.countAll<string>().as('n')])
    .where('batch_id', '=', row.batchId)
    .groupBy('verdict')
    .execute();

  let decisions = 0;
  let refused = 0;
  for (const v of verdicts) {
    const n = Number.parseInt(v.n, 10);
    decisions += n;
    if (v.verdict !== 'fire') refused += n;
  }

  // ---- the link, found rather than created --------------------------------
  let paymentUrl: string | null = null;
  let warning: string | null = null;

  const razorpay = readConfig();
  if (razorpay.config === undefined) {
    warning = `No Razorpay keys configured, so the mail carries no link. ${razorpay.problem ?? ''}`.trim();
  } else {
    const reference = toReference(row.idempotencyKey ?? row.decisionId);
    try {
      const existing = await findLinkByReference(razorpay.config, reference);
      if (existing === null) {
        warning =
          'No payment link has been issued for this decision yet — run ' +
          '`pnpm razorpay --live` first, then dispatch again for a mail that carries one.';
      } else {
        paymentUrl = existing.short_url;
      }
    } catch (cause) {
      // A lookup failure must not block the dispatch. The message and its arithmetic are the
      // substance; the link is the part that needs a third party to be reachable.
      warning =
        cause instanceof RazorpayError
          ? `Could not reach Razorpay to find the link: ${cause.message}`
          : 'Could not reach Razorpay to find the link.';
    }
  }

  const input = {
    message: script.text,
    templateId: row.templateId,
    dltTemplateId: row.dltId,
    amount: PaiseSchema.parse(row.amount),
    reasonCode: row.reasonCode,
    riskClass: row.riskClass,
    // Nullable on the row for actions that are not attempts; a fired payment_link always
    // has one, and 1 is the honest floor rather than printing "attempt null".
    attemptNo: row.attemptNo ?? 1,
    paymentUrl,
    decisionId: row.decisionId,
    pBps: row.pBps,
    value: PaiseSchema.parse(row.value),
    cost: PaiseSchema.parse(row.cost),
    net: PaiseSchema.parse(row.net),
    floor: loadPolicy().evFloor,
    refusedInBatch: refused,
    decisionsInBatch: decisions,
  };

  try {
    const sent = await mail.provider.send({
      to: mail.to,
      from: mail.from,
      subject: subjectFor(input),
      html: htmlFor(input),
      text: textFor(input),
    });

    return {
      ok: true,
      to: mail.to,
      messageId: sent.id,
      paymentUrl,
      warning,
      error: null,
    };
  } catch (cause) {
    // Returned rather than thrown, so the button can print a sentence and stay usable. The
    // likeliest failure is Resend's free-tier recipient restriction, and its own wording for
    // that reads like a broken key — `@rc/mail` rewrites it into something actionable.
    return {
      ok: false,
      ...nothing,
      error:
        cause instanceof MailError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Dispatch failed.',
    };
  }
}

/** For the button's label: the amount this dispatch would be about. */
export async function amountFor(sendId: number): Promise<string | null> {
  const row = await db()
    .selectFrom('message_send')
    .innerJoin('decision', 'decision.id', 'message_send.decision_id')
    .innerJoin('txn', 'txn.id', 'decision.txn_id')
    .select(['txn.amount_paise as amount'])
    .where('message_send.id', '=', sendId)
    .executeTakeFirst();

  return row === undefined ? null : formatINR(PaiseSchema.parse(row.amount));
}
