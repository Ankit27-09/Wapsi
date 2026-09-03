import { z } from 'zod';
import { authHeader, type RazorpayConfig } from './config.js';

/**
 * A thin, validated HTTP client for Razorpay's REST API.
 *
 * WHY `fetch` AND NOT THE OFFICIAL SDK.
 *
 * Two methods are needed, the API is plain REST over Basic auth, and Node has had `fetch` for
 * years. Against that, the SDK is a dependency to keep current whose types describe rather
 * than enforce the response shape — and this codebase's rule at every other boundary is that
 * external data is VALIDATED, not trusted. A gateway response decides whether a customer is
 * asked for money, so it gets the same treatment as the policy YAML and the failure strings:
 * parsed through Zod, with a loud failure if the shape drifts.
 *
 * That last point matters more than it looks. If Razorpay renames a field, an untyped SDK
 * hands back `undefined` and the code carries on with a missing link id. Here it throws with
 * the field named.
 */

/** Razorpay's own error envelope. Sent with 4xx and 5xx alike. */
const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    description: z.string().optional(),
    reason: z.string().nullish(),
    step: z.string().nullish(),
    source: z.string().nullish(),
    field: z.string().nullish(),
  }),
});

/**
 * A failure from Razorpay, carrying enough to act on rather than just a status code.
 *
 * `duplicate` is separated out because it is the one failure that is not a failure: creating a
 * link whose `reference_id` already exists means a previous run already created it. That is
 * idempotency working, and the caller should fetch the existing link rather than retry.
 */
export class RazorpayError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly duplicate: boolean;

  constructor(args: {
    readonly status: number;
    readonly code: string | null;
    readonly description: string;
    readonly duplicate: boolean;
  }) {
    super(
      `Razorpay ${args.status}${args.code === null ? '' : ` ${args.code}`}: ${args.description}`,
    );
    this.name = 'RazorpayError';
    this.status = args.status;
    this.code = args.code;
    this.duplicate = args.duplicate;
  }
}

export interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /** Abort after this many ms. A hung request must not stall a demo indefinitely. */
  readonly timeoutMs?: number;
  /**
   * How long to wait before retrying attempt `n`. Tests only — omit for the real schedule.
   *
   * The same reason the provider layer in `@rc/ai` takes one: sleeping through a real
   * backoff to assert on an error added fifteen seconds to a suite, and a suite slow enough
   * to skip is a suite that stops catching things.
   */
  readonly retryDelayMs?: (attempt: number) => number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

/** Attempts before giving up on a rate limit or a transient server fault. */
export const MAX_ATTEMPTS = 4;

/**
 * Bounded exponential backoff with jitter.
 *
 * The jitter is not decoration: two terminals running `pnpm razorpay --live` together would
 * otherwise retry in lockstep and re-trigger the same throttle that stopped them.
 */
export function backoffMs(attempt: number): number {
  return Math.min(6_000, 700 * 2 ** attempt) + Math.floor(Math.random() * 300);
}

/**
 * Whether repeating this request could plausibly succeed.
 *
 * A 429 is the one that matters in practice: Razorpay's test API throttles, and a run of
 * three links hit it on the third. A 400 will fail identically forever, and a duplicate is
 * not a failure at all — `ensureLink` handles that by looking the link up.
 */
function worthRetrying(error: RazorpayError): boolean {
  if (error.duplicate) return false;
  return error.status === 429 || error.status >= 500 || error.status === 0;
}

/**
 * Retry on a rate limit, and the reason this is SAFE is the whole design.
 *
 * Retrying a POST that creates a demand for money is normally reckless — a 429 is ambiguous
 * about whether the resource was created before the response was refused. Here it is not,
 * because every create carries `reference_id`, derived from the engine's idempotency key,
 * and Razorpay enforces uniqueness on it. So a repeat is either accepted (the first never
 * landed) or rejected as a duplicate (it did), and `ensureLink` resolves the second case by
 * fetching the existing link. The worst outcome of a retry is a wasted request.
 *
 * Without this, one link in three failed on a live run — which is not the system behaving
 * badly, but it prints `FAILED` and reads as though it were. The provider layer in `@rc/ai`
 * has had this ladder since the first live ablation; this client did not, and the
 * inconsistency was an oversight rather than a decision.
 */
export async function request<T>(
  config: RazorpayConfig,
  options: RequestOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  let last: RazorpayError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await attemptRequest(config, options, schema);
    } catch (cause) {
      if (!(cause instanceof RazorpayError)) throw cause;
      last = cause;
      if (!worthRetrying(cause) || attempt === MAX_ATTEMPTS - 1) throw cause;

      const waitMs = (options.retryDelayMs ?? backoffMs)(attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw (
    last ??
    new RazorpayError({
      status: 0,
      code: 'NO_ATTEMPT',
      description: 'The retry loop exited without attempting a request.',
      duplicate: false,
    })
  );
}

/**
 * Perform ONE request and validate the response against `schema`.
 *
 * Every branch that can produce a non-response is turned into a `RazorpayError` with a
 * readable message, because the single most likely thing to go wrong during a live demo is
 * the network — and "TypeError: fetch failed" on a projector is not a diagnosis.
 */
async function attemptRequest<T>(
  config: RazorpayConfig,
  options: RequestOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = `${config.RAZORPAY_API_BASE}${options.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: authHeader(config),
        'Content-Type': 'application/json',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    // Inside the try, so the abort signal covers the BODY as well as the headers. It did
    // not before: `clearTimeout` ran the moment `fetch` resolved, so a stalled body waited
    // forever with nothing to interrupt it. The identical bug in `@rc/ai` presented as a
    // batch that hung with zero recorded calls.
    text = await response.text();
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    throw new RazorpayError({
      status: 0,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      description: aborted
        ? `No response from ${url} within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`
        : `Could not reach ${url}. ${cause instanceof Error ? cause.message : String(cause)}`,
      duplicate: false,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(safeJson(text));
    const description = parsed.success
      ? (parsed.data.error.description ?? text.slice(0, 300))
      : text.slice(0, 300);
    const code = parsed.success ? (parsed.data.error.code ?? null) : null;

    // Razorpay reports a re-used `reference_id` as a 400 whose description names it. Detected
    // on the description rather than the code because the code is the generic
    // BAD_REQUEST_ERROR, which says nothing about which of forty validations failed.
    const duplicate = /already exists|duplicate/i.test(description);

    throw new RazorpayError({ status: response.status, code, description, duplicate });
  }

  const parsed = schema.safeParse(safeJson(text));
  if (!parsed.success) {
    throw new RazorpayError({
      status: response.status,
      code: 'UNEXPECTED_SHAPE',
      description:
        `Razorpay returned 200 with a body this client does not recognise. ` +
        `That usually means the API changed. Problems: ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
          .join('; '),
      duplicate: false,
    });
  }

  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
