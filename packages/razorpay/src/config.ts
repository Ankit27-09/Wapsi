import { z } from 'zod';

/**
 * Credentials and mode, validated at the boundary.
 *
 * TEST MODE IS ENFORCED HERE, not left to the operator's attention. A Razorpay key id carries
 * its own mode: test keys begin `rzp_test_`, live keys begin `rzp_live_`. This module refuses a
 * live key outright rather than trusting whoever set the variable.
 *
 * The reason is specific rather than general caution. This package creates PAYMENT LINKS — a
 * demand for money sent to a customer. A live key here would mean a demonstration issuing real
 * payment demands against synthetic customers invented by a simulator. No sensible flag
 * protects against that; the only safe design is for a live key to be unrepresentable.
 */

const KeyIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('rzp_test_'), {
    message:
      'Refusing a key that is not a Razorpay TEST key (rzp_test_...). This package creates ' +
      'payment links against customers a simulator invented, so a live key would issue real ' +
      'demands for money to people who do not exist.',
  });

const EnvSchema = z.object({
  RAZORPAY_KEY_ID: KeyIdSchema,
  RAZORPAY_KEY_SECRET: z.string().min(1),
  /** Razorpay's API host. Overridable only so a test can point at a local stub. */
  RAZORPAY_API_BASE: z.string().url().default('https://api.razorpay.com/v1'),
});

export type RazorpayConfig = z.infer<typeof EnvSchema>;

export interface ConfigResult {
  readonly ok: boolean;
  readonly config?: RazorpayConfig;
  readonly problem?: string;
}

/**
 * Read the configuration, without throwing.
 *
 * A result rather than an exception because the caller has something useful to do when the
 * keys are absent: run in dry-run mode and print exactly what WOULD be sent. That keeps the
 * whole integration demonstrable on a laptop with no keys and no network, which matters more
 * than it sounds — the alternative is a feature that only exists when the wifi works.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const parsed = EnvSchema.safeParse(env);

  if (parsed.success) return { ok: true, config: parsed.data };

  const problem = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    .join('\n    ');

  return { ok: false, problem };
}

/** HTTP Basic, which is what Razorpay's REST API uses. */
export function authHeader(config: RazorpayConfig): string {
  const raw = `${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}
