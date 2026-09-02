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
}

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Perform one request and validate the response against `schema`.
 *
 * Every branch that can produce a non-response is turned into a `RazorpayError` with a
 * readable message, because the single most likely thing to go wrong during a live demo is
 * the network — and "TypeError: fetch failed" on a projector is not a diagnosis.
 */
export async function request<T>(
  config: RazorpayConfig,
  options: RequestOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = `${config.RAZORPAY_API_BASE}${options.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
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

  const text = await response.text();

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
