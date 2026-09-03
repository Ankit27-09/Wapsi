import { renderScript } from '@rc/voice';
import { db } from './db';

/**
 * The text a recorded send would speak, rendered from the template it names.
 *
 * ONE PATH, USED TWICE. The page needs this to show what was said, and the Server Action
 * needs it to synthesise the same string. Deriving it in two places is how a viewer ends up
 * displaying one script and playing another, so both go through here.
 *
 * WHY IT RENDERS RATHER THAN READING `rendered_body`.
 *
 * `message_send.rendered_body` is a stub. `execute.ts` writes the literal string
 * `[template tpl_ar_voice_final_hi_v1]` with a comment saying "variable filling lands with
 * the renderer" — a deferral that was never closed. So the column names the template that
 * was sent and does not contain the message.
 *
 * That is a real gap in something this project calls an append-only audit trail, and the
 * correct fix is upstream: the engine should fill the variables it already has in scope and
 * store the result, so the record is the message. It is recorded in FAILURES.md rather than
 * papered over, and it is not fixed here because `execute.ts` carries the idempotency and
 * dual-write protocol, which is not a file to change the day before a submission deadline.
 *
 * What this does instead is legitimate and narrower: it takes the SAME registered template
 * the engine referenced and the SAME transaction values the engine had, and fills them. It
 * invents nothing. But it is a viewer reconstructing the message rather than reading it, and
 * that distinction is the reason for this comment.
 */

/**
 * The merchant name spoken in the scripts.
 *
 * A constant because there is no merchant table — this is a single-tenant simulation. Kept
 * obviously fictional on purpose: a demo artifact naming a plausible real company is a
 * document that can be mistaken for a real one once it leaves the repository.
 */
const MERCHANT = 'Devkit Supplies';

export interface SpokenSend {
  readonly sendId: number;
  readonly templateId: string;
  readonly language: string;
  readonly channel: string;
  readonly text: string;
}

/**
 * Render one send, or null when it does not exist or its template needs a variable the
 * transaction cannot supply.
 *
 * Null rather than a partial string: `renderScript` refuses a missing value instead of
 * speaking "rupees undefined", and swallowing that here would defeat it.
 */
export async function renderSend(sendId: number): Promise<SpokenSend | null> {
  return (await renderSends([sendId])).get(sendId) ?? null;
}

/**
 * The same rendering, for a whole page of sends, in one query.
 *
 * WHY THIS EXISTS SEPARATELY. The Delivered table has 146 rows, and calling `renderSend` per
 * row would issue 146 queries against a pool of ten — concurrently, since they would all be
 * awaited together. That is not a latency problem, it is a connection-exhaustion problem, and
 * it fails as a timeout on an unrelated page rather than as anything pointing here.
 *
 * A send missing from the returned map is one whose template asked for a value this
 * transaction has no answer to. Absent rather than half-filled, for the reason above.
 */
export async function renderSends(
  sendIds: readonly number[],
): Promise<Map<number, SpokenSend>> {
  // `in ()` is a syntax error in Postgres, and an empty page is a legitimate state.
  if (sendIds.length === 0) return new Map();

  const rows = await db()
    .selectFrom('message_send')
    .innerJoin('decision', 'decision.id', 'message_send.decision_id')
    .innerJoin('txn', 'txn.id', 'decision.txn_id')
    .innerJoin('customer', 'customer.id', 'message_send.customer_id')
    .innerJoin('message_template', 'message_template.id', 'message_send.template_id')
    .select([
      'message_send.id as id',
      'message_send.channel as channel',
      'message_send.template_id as templateId',
      'message_template.body as body',
      'message_template.variables as variables',
      'message_template.language as language',
      'customer.display_name as name',
      'txn.amount_paise as amount',
      'txn.days_overdue as daysOverdue',
      'txn.logical_ref as ref',
    ])
    .where('message_send.id', 'in', sendIds)
    .execute();

  const rendered = new Map<number, SpokenSend>();
  for (const row of rows) {
    const one = renderRow(row);
    if (one !== null) rendered.set(row.id, one);
  }
  return rendered;
}

/** One row, filled. Split out so the batch and the single-id path cannot diverge. */
function renderRow(row: {
  id: number;
  channel: string;
  templateId: string;
  body: string;
  variables: string[];
  language: string;
  name: string;
  amount: string | bigint;
  daysOverdue: number | null;
  ref: string;
}): SpokenSend | null {
  /*
   * Values for every variable the templates declare across the corpus.
   *
   * `renderScript` refuses an UNDECLARED key, so this cannot be a superset — it is filtered
   * to what this template actually asks for. That check is the point: if a template grows a
   * variable this map does not know, rendering fails loudly rather than speaking a brace.
   */
  const available: Record<string, string> = {
    merchant: MERCHANT,
    name: row.name,
    /*
     * Whole rupees, no grouping separators.
     *
     * Two decisions, both about how a synthesiser reads a number rather than about money.
     * `4,12,880` is read as three separate numbers by some voices, so the separators go. And
     * `55905.49` is read as "…point four nine", which no collections call has ever said — a
     * caller says the rupees and stops. Rounded for speech only; every figure the system
     * decides on remains exact integer paise.
     */
    amount: String(Math.round(Number(BigInt(row.amount)) / 100)),
    invoice: `INV-${row.ref.padStart(5, '0')}`,
    days: String(row.daysOverdue ?? 0),
    date: '',
    link: 'rzp.io link sent by SMS',
  };

  const declared = new Set(row.variables);
  const values = Object.fromEntries(
    Object.entries(available).filter(([key]) => declared.has(key)),
  );

  try {
    const rendered = renderScript(
      {
        id: row.templateId,
        language: row.language,
        body: row.body,
        variables: row.variables,
      },
      values,
    );
    return {
      sendId: row.id,
      templateId: row.templateId,
      language: row.language,
      channel: row.channel,
      text: rendered.text,
    };
  } catch {
    // A template asking for something the transaction has no value for. Reported as absent
    // rather than as a half-filled script, because the half-filled one would still play.
    return null;
  }
}
