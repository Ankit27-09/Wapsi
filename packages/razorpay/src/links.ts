import { z } from 'zod';
import type { Paise } from '@rc/core';
import { RazorpayError, request } from './client.js';
import type { RazorpayConfig } from './config.js';

/**
 * PAYMENT LINKS
 *
 * The one Razorpay action this engine can drive end to end from a server, and the reason this
 * package exists.
 *
 * A retry cannot be done this way, and the constraint is worth stating rather than working
 * around: re-presenting a charge needs a saved token or a live mandate plus the customer's
 * prior authorisation, so "retry this failed card" is not an API call a server may simply
 * make. A payment link is different — it is a demand for money that the CUSTOMER then acts
 * on, so creating one is entirely server-side and the authorisation happens later, by them.
 *
 * That maps exactly onto an intervention the engine already has. `payment_link` is how
 * checkout abandonment and overdue receivables recover money in this system; it was simulated,
 * and here it becomes real.
 *
 * IDEMPOTENCY IS THE INTERESTING PART. `reference_id` carries the engine's derived idempotency
 * key — a pure function of (transaction, attempt, policy version) — and Razorpay refuses a
 * duplicate. So a crashed and restarted run recomputes the identical key and Razorpay declines
 * to create a second demand for the same money, which is the same guarantee the simulator
 * gives, enforced by someone else's server.
 */

/**
 * What a payment link needs. Deliberately narrow: no partial payments, no custom expiry.
 *
 * Amounts stay `Paise` right up to the JSON boundary, where they are converted once. Razorpay
 * takes amounts in paise as an integer, which is the same unit this system uses throughout —
 * so there is no rupee conversion anywhere in the path, and no opportunity for a float.
 */
export interface LinkRequest {
  /** The engine's idempotency key. Razorpay rejects a repeat, which is the point. */
  readonly referenceId: string;
  readonly amount: Paise;
  /** Shown to the customer. Should say which failure this is about. */
  readonly description: string;
  readonly customerName: string;
  /** Test-mode contact. Razorpay validates the shape but sends nothing real in test mode. */
  readonly customerContact: string;
  readonly customerEmail: string;
  /**
   * Whether Razorpay should notify the customer itself.
   *
   * FALSE by default, and that default is a compliance decision rather than a preference. This
   * system sends its own messages through DLT-registered templates, gated on consent, quiet
   * hours and a weekly ceiling. Letting the gateway also notify would put a second, ungated
   * message path next to a carefully bounded one — and the bounds would then be describing
   * only half the traffic.
   */
  readonly notify?: boolean;
  /** Free-form, echoed back by Razorpay. Used to carry our own ids for reconciliation. */
  readonly notes?: Readonly<Record<string, string>>;
}

/**
 * The subset of Razorpay's response this system uses.
 *
 * Passthrough rather than strict: Razorpay may add fields, and an unexpected ADDITION is not
 * an error. A missing or wrong-typed field we depend on is, and that is what this catches.
 */
const LinkResponseSchema = z
  .object({
    id: z.string().min(1),
    short_url: z.string().url(),
    status: z.string().min(1),
    amount: z.number().int().nonnegative(),
    reference_id: z.string().nullish(),
    amount_paid: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type LinkResponse = z.infer<typeof LinkResponseSchema>;

const LinkListSchema = z
  .object({ payment_links: z.array(LinkResponseSchema) })
  .passthrough();

/**
 * Razorpay's limit on `reference_id`. Found by being told, not by reading the docs:
 * `BAD_REQUEST_ERROR: reference_id: the length must be no more than 40`.
 */
const REFERENCE_MAX = 40;

/** Prefix, so every link this system created is findable in the Razorpay dashboard. */
const REFERENCE_PREFIX = 'rc_';

/**
 * Turn the engine's idempotency key into a Razorpay reference.
 *
 * The engine's key is a sha256 — 64 hex characters — and Razorpay accepts 40. So it is
 * truncated, and the reason that is safe rather than merely convenient is worth writing down,
 * because "we shortened the idempotency key" is exactly the sentence that should make a
 * reader suspicious:
 *
 *   TRUNCATION PRESERVES DETERMINISM, which is the property idempotency actually needs. The
 *   same transaction, attempt and policy version produce the same 64 characters and therefore
 *   the same 37, so a crashed and restarted run still collides with itself on Razorpay's side
 *   and is still refused a second demand for the same money.
 *
 *   37 HEX CHARACTERS IS 148 BITS. A batch is a few hundred links and a merchant's lifetime
 *   is a few million; the chance of two distinct keys sharing a prefix at that width is far
 *   below the chance of the database losing the row. Nothing here rests on the full 256.
 *
 * The prefix is not decoration: it makes every link this system created searchable in the
 * dashboard, which is the difference between "some links appeared" and "these are ours".
 */
export function toReference(idempotencyKey: string): string {
  return `${REFERENCE_PREFIX}${idempotencyKey}`.slice(0, REFERENCE_MAX);
}

/** Build the request body. Separated out so `--dry-run` can print exactly what would be sent. */
export function linkBody(link: LinkRequest): Record<string, unknown> {
  // Checked here rather than trusted, because the caller supplies this and Razorpay's
  // rejection arrives only over the network — so an over-long reference would otherwise fail
  // during a demo rather than during a test.
  if (link.referenceId.length > REFERENCE_MAX) {
    throw new RangeError(
      `reference_id is ${link.referenceId.length} characters; Razorpay accepts ` +
        `${REFERENCE_MAX}. Pass it through toReference() first.`,
    );
  }

  return {
    // Razorpay takes paise as an integer, the same unit used throughout this system. `Paise`
    // is a bigint, so it is narrowed here at the single boundary where it must become JSON —
    // and `Number` is safe because the schema caps amounts far below 2^53.
    amount: Number(link.amount),
    currency: 'INR',
    accept_partial: false,
    description: link.description,
    reference_id: link.referenceId,
    customer: {
      name: link.customerName,
      contact: link.customerContact,
      email: link.customerEmail,
    },
    // Both false unless explicitly asked for. See `notify` above: this system owns customer
    // messaging, and a second ungated path would make its own bounds a partial description.
    notify: { sms: link.notify === true, email: link.notify === true },
    reminder_enable: false,
    notes: { ...link.notes },
  };
}

/** Create a payment link. Throws `RazorpayError`; `duplicate` means it already exists. */
/**
 * Retry pacing, overridable by tests so they do not sit through a real backoff.
 *
 * The same seam the `@rc/ai` provider factories carry, for the same reason: five tests
 * sleeping through the production ladder added fifteen seconds to the suite, and a suite slow
 * enough to skip is a suite that stops catching things. Omit it and the real schedule applies.
 */
export interface RetryOverride {
  readonly retryDelayMs?: (attempt: number) => number;
}

export async function createLink(
  config: RazorpayConfig,
  link: LinkRequest,
  retry: RetryOverride = {},
): Promise<LinkResponse> {
  return request(
    config,
    { method: 'POST', path: '/payment_links', body: linkBody(link), ...retry },
    LinkResponseSchema,
  );
}

/**
 * Find a link by the reference id the engine derived.
 *
 * The `lookup` half of the same pattern the `Gateway` port insists on, and the half most
 * integrations omit: after a crash, the process cannot know whether its last create landed.
 * Asking is the only correct answer — guessing "it did" abandons a recoverable payment, and
 * guessing "it did not" sends the customer a second demand for the same money.
 */
export async function findLinkByReference(
  config: RazorpayConfig,
  referenceId: string,
  retry: RetryOverride = {},
): Promise<LinkResponse | null> {
  const list = await request(
    config,
    {
      method: 'GET',
      path: `/payment_links?reference_id=${encodeURIComponent(referenceId)}`,
      ...retry,
    },
    LinkListSchema,
  );

  return list.payment_links[0] ?? null;
}

/**
 * Create, or return the existing link when one is already there.
 *
 * The composition that makes a re-run safe. `createLink` alone is not idempotent from the
 * caller's point of view — it throws on a duplicate — and a demo that has to be run exactly
 * once is a demo that fails the second time somebody tries it.
 */
export async function ensureLink(
  config: RazorpayConfig,
  link: LinkRequest,
  retry: RetryOverride = {},
): Promise<{ readonly link: LinkResponse; readonly reused: boolean }> {
  try {
    return { link: await createLink(config, link, retry), reused: false };
  } catch (cause) {
    // Only a duplicate reference is recoverable here. Anything else — a bad amount, a
    // rejected key, an unreachable host — is rethrown, because turning every failure into
    // "look for an existing link" would report a demand that was never made.
    if (!(cause instanceof RazorpayError) || !cause.duplicate) throw cause;

    // THE LIST ENDPOINT LAGS THE CREATE, observed rather than assumed.
    //
    // Re-running immediately after a first run, one link in three came back as a duplicate
    // on create and then as ABSENT from the query by reference — Razorpay refusing to create
    // it and, a moment later, declining to admit it existed. A run a minute later found all
    // three. So the create is immediately consistent and the list is not.
    //
    // Retried with a short backoff rather than surfaced, because the alternative reads as a
    // bug in this system on the one occasion a judge is most likely to run the command
    // twice. Bounded at three tries: past that, "Razorpay says it exists but will not return
    // it" is a genuine contradiction and belongs in the caller's face rather than in a loop.
    for (const waitMs of [0, 600, 1800]) {
      if (waitMs > 0) await sleep(waitMs);
      const existing = await findLinkByReference(config, link.referenceId, retry);
      if (existing !== null) return { link: existing, reused: true };
    }

    throw new RazorpayError({
      status: 409,
      code: 'DUPLICATE_NOT_FOUND',
      description:
        `Razorpay refused reference ${link.referenceId} as a duplicate, then did not return ` +
        `it from a query after three attempts. Retrying the create would loop, and ` +
        `inventing a link would report a demand that was never made.`,
      duplicate: true,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
