import { z } from 'zod';

/**
 * Email dispatch, behind one interface, for the same reason the classifier and the speech
 * layer are.
 *
 * WHAT THIS LAYER IS FOR, and the framing is deliberate rather than modest.
 *
 * The engine has no email channel. There are twenty registered SMS templates, two voice, and
 * ZERO email — and the seeded customer book has no email consent rows at all, so
 * `checkContactBounds` would refuse an email to every customer in it. That is not an
 * oversight to work around; it is the compliance layer being correct.
 *
 * So this does not send outreach to a customer. It dispatches, to the OPERATOR'S OWN ADDRESS,
 * the message a decision already produced — with the expected-value arithmetic that justified
 * it in the body. It is a preview of a decision, addressed to the person who owns the system,
 * and calling it anything else would be claiming a channel this project has not built.
 *
 * The distinction is enforced rather than described: the caller supplies the recipient from
 * `MAIL_TO`, and there is no code path from a customer record to a recipient address.
 */

export const MAIL_PROVIDER_IDS = ['resend'] as const;
export type MailProviderId = (typeof MAIL_PROVIDER_IDS)[number];

export interface MailMessage {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly html: string;
  /** Plain-text alternative. Not optional: a mail without one lands in more spam filters. */
  readonly text: string;
}

export interface MailResult {
  readonly id: string;
  readonly provider: MailProviderId;
}

export interface MailProvider {
  readonly id: MailProviderId;
  send(message: MailMessage): Promise<MailResult>;
}

export class MailError extends Error {
  readonly provider: MailProviderId;
  readonly status: number;

  constructor(options: { provider: MailProviderId; status: number; message: string }) {
    super(`${options.provider}: ${options.message}`);
    this.name = 'MailError';
    this.provider = options.provider;
    this.status = options.status;
  }
}

/** Resend returns the queued message id. Validated rather than trusted, like every boundary. */
const ResendResponseSchema = z.object({ id: z.string().min(1) });

const ResendErrorSchema = z.object({
  message: z.string().optional(),
  name: z.string().optional(),
});

/** Longest we wait on the API before treating it as unreachable. */
const TIMEOUT_MS = 15_000;

export function createResend(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
}): MailProvider {
  const base = options.baseUrl ?? 'https://api.resend.com';

  return {
    id: 'resend',

    async send(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response: Response;
      let body: string;
      try {
        response = await fetch(`${base}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: controller.signal,
        });
        // Inside the try, so the abort signal covers the body as well as the headers — the
        // same hole that made two other clients in this repo hang indefinitely.
        body = await response.text();
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === 'AbortError';
        throw new MailError({
          provider: 'resend',
          status: 0,
          message: aborted
            ? `no response within ${TIMEOUT_MS}ms`
            : cause instanceof Error
              ? cause.message
              : 'network failure',
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const parsed = ResendErrorSchema.safeParse(safeJson(body));
        const detail = parsed.success ? parsed.data.message : undefined;

        throw new MailError({
          provider: 'resend',
          status: response.status,
          // THE 403 IS THE ONE WORTH EXPLAINING, because it is the expected failure rather
          // than a bug. On the free tier without a verified domain Resend will only deliver
          // to the address the account was created with, and its own message about that is
          // terse enough to look like a broken key.
          message:
            response.status === 403
              ? `${detail ?? 'forbidden'} — on the free tier Resend only delivers to the ` +
                `address the account was created with. Set MAIL_TO to that address.`
              : (detail ?? (body.slice(0, 240) || `HTTP ${response.status}`)),
        });
      }

      const parsed = ResendResponseSchema.safeParse(safeJson(body));
      if (!parsed.success) {
        throw new MailError({
          provider: 'resend',
          status: response.status,
          message: 'accepted the message but returned a body this client does not recognise',
        });
      }

      return { id: parsed.data.id, provider: 'resend' };
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Placeholders in `.env.example`. Treated as absent so a copied file fails clearly. */
const PLACEHOLDERS = new Set(['', '...', 'change-me', 'your-key-here']);

function usable(value: string | undefined): value is string {
  return value !== undefined && !PLACEHOLDERS.has(value.trim());
}

export interface MailResolution {
  readonly provider: MailProvider | null;
  readonly from: string;
  readonly to: string;
  /** Non-null when dispatch is not possible, saying which piece is missing. */
  readonly problem: string | null;
}

/**
 * Resolve the provider and both addresses from the environment.
 *
 * `MAIL_TO` HAS NO DEFAULT AND IS NOT DERIVED FROM ANY CUSTOMER RECORD. It is the operator's
 * own address, supplied deliberately. A default here — or worse, a fallback that reached into
 * `customer` — would turn a preview feature into an outreach channel the compliance layer
 * never authorised.
 */
export function resolveMail(env: NodeJS.ProcessEnv = process.env): MailResolution {
  const key = env['RESEND_API_KEY'];
  const from = env['MAIL_FROM']?.trim() ?? 'Wapsi <onboarding@resend.dev>';
  const to = env['MAIL_TO']?.trim() ?? '';

  if (!usable(key)) {
    return {
      provider: null,
      from,
      to,
      problem: 'RESEND_API_KEY is not set. Get one free at resend.com — no card, no domain.',
    };
  }

  if (!usable(to)) {
    return {
      provider: null,
      from,
      to,
      problem:
        'MAIL_TO is not set. It is the operator’s own address, and it has no default on ' +
        'purpose — nothing here derives a recipient from a customer record. On the free ' +
        'tier it must be the address the Resend account was created with.',
    };
  }

  if (!to.includes('@')) {
    return { provider: null, from, to, problem: `MAIL_TO is not an address: "${to}"` };
  }

  return { provider: createResend({ apiKey: key }), from, to, problem: null };
}
