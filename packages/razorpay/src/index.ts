/**
 * @rc/razorpay — the live gateway client.
 *
 * The production counterpart to `@rc/simulator`: where that package invents a world in order
 * to measure decisions against a knowable bound, this one executes a decision against
 * Razorpay's real API in test mode.
 *
 * It is ADDITIVE, and the distinction is load-bearing. Nothing in the evaluation path imports
 * this package, and nothing here decides anything — it reads decisions the engine has already
 * made and carries one of them out. A share of an achievable ceiling can only be measured
 * where ground truth exists, so replacing the simulator with a live gateway would not improve
 * the headline result; it would remove the thing that makes it a result.
 *
 * Scope is one action, for a reason worth stating rather than hiding: a RETRY cannot be driven
 * from a server. Re-presenting a charge needs a saved token or a live mandate plus the
 * customer's prior authorisation. A payment link is the opposite — a demand the customer acts
 * on later — so creating one is entirely server-side, and it happens to be exactly the
 * intervention two of this system's five risk classes recover money with.
 */

export { RazorpayError, request, type RequestOptions } from './client.js';
export { authHeader, readConfig, type ConfigResult, type RazorpayConfig } from './config.js';
export {
  createLink,
  ensureLink,
  findLinkByReference,
  linkBody,
  type LinkRequest,
  type LinkResponse,
} from './links.js';
