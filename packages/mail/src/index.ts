/**
 * @rc/mail — dispatching a decision, not composing one.
 *
 * The engine has no email channel: twenty registered SMS templates, two voice, zero email,
 * and no email consent anywhere in the seeded book. So this package does not send outreach to
 * customers, and saying otherwise would claim a channel the compliance layer never authorised.
 *
 * What it does is dispatch, to the operator's own address, the message a decision already
 * produced — carrying the expected-value arithmetic that justified it. A preview of a
 * decision, addressed to the person who owns the system.
 *
 * `MAIL_TO` has no default and nothing here derives a recipient from a customer record.
 */

export {
  MAIL_PROVIDER_IDS,
  MailError,
  createResend,
  resolveMail,
  type MailMessage,
  type MailProvider,
  type MailProviderId,
  type MailResolution,
  type MailResult,
} from './providers.js';

export { htmlFor, subjectFor, textFor, type DispatchInput } from './render.js';
