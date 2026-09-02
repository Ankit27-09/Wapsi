import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * OPERATOR AUTHORISATION
 *
 * A shared secret gating the two actions that change what the system is permitted to do:
 * approving a policy proposal, and rejecting one.
 *
 * WHY THIS IS NOT DECORATION.
 *
 * The whole safety argument of the improvement loop is "the agent proposes, a HUMAN decides".
 * Without a credential, that sentence describes a convention rather than a control: anyone
 * who could run the command could change the rules that move money, and the audit row would
 * record whatever name they typed into `--operator`. The trail would say a human approved it
 * and be unable to establish that one had.
 *
 * The token was documented in `.env.example` and read by nothing, which is worse than absent.
 * A claimed control that does not exist gives a reader reason to doubt the ones that do — and
 * this project's credibility rests on not claiming what it has not done.
 *
 * WHAT THIS IS NOT. A shared secret in an environment file is not identity, not
 * non-repudiation, and not multi-operator access control. It establishes that whoever ran the
 * command held the secret. Real deployment wants SSO and per-operator keys, and that is said
 * plainly in the README rather than implied away by the presence of a check.
 */

/**
 * The placeholder `.env.example` ships with.
 *
 * Refused outright, in the same spirit as the live Razorpay key: the unsafe value does not
 * work, rather than working with a warning nobody reads. Someone who copies the example file
 * and approves a proposal has authenticated against a string published in the repository.
 */
const PLACEHOLDER = 'change-me-locally';

const MIN_LENGTH = 16;

export type AuthResult =
  | { readonly ok: true; readonly operator: string }
  | { readonly ok: false; readonly problem: string };

/**
 * Check the presented token against the configured one.
 *
 * `timingSafeEqual` rather than `===`, and the reason is worth stating even though the threat
 * is remote here: string comparison short-circuits on the first differing byte, so the time it
 * takes leaks how many leading characters were right. That is how a secret gets guessed one
 * character at a time. It costs one function call to not have that property.
 */
export function authorise(args: {
  readonly presented: string | undefined;
  readonly operator: string;
  readonly env?: NodeJS.ProcessEnv;
}): AuthResult {
  const env = args.env ?? process.env;
  const configured = env['OPERATOR_TOKEN'];

  if (configured === undefined || configured === '') {
    return {
      ok: false,
      problem:
        'OPERATOR_TOKEN is not set. Approving or rejecting a policy proposal changes the ' +
        'rules that move money, so it requires the operator secret.\n\n' +
        '    Add a value of at least 16 characters to .env, then pass it with --token.',
    };
  }

  if (configured === PLACEHOLDER) {
    return {
      ok: false,
      problem:
        `OPERATOR_TOKEN is still the placeholder from .env.example ("${PLACEHOLDER}").\n\n` +
        '    That string is published in this repository, so authenticating against it ' +
        'establishes nothing.\n    Set a real value.',
    };
  }

  if (configured.length < MIN_LENGTH) {
    return {
      ok: false,
      problem:
        `OPERATOR_TOKEN is ${configured.length} characters; at least ${MIN_LENGTH} are ` +
        'required. A secret short enough to guess is a formality rather than a control.',
    };
  }

  if (args.presented === undefined || args.presented === '') {
    return {
      ok: false,
      problem:
        'No --token supplied. Approving or rejecting a proposal requires the operator ' +
        'secret.\n\n    pnpm propose --approve 3 --token "$OPERATOR_TOKEN"',
    };
  }

  if (!constantTimeEquals(args.presented, configured)) {
    return { ok: false, problem: 'The token supplied does not match OPERATOR_TOKEN.' };
  }

  if (args.operator.trim() === '') {
    return {
      ok: false,
      problem:
        'An empty --operator would put an anonymous approval in the audit trail. Name who ' +
        'is deciding.',
    };
  }

  return { ok: true, operator: args.operator };
}

/**
 * Compare two strings without leaking their common prefix through timing.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which itself leaks the length —
 * so both sides are hashed to a fixed width first and the digests are compared. Length is
 * then not observable at all.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}
