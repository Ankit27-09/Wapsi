import { PaiseSchema, bps, formatINR, mulBps, type Paise } from '@rc/core';
import { createDb } from '@rc/db';
import { RazorpayError } from './client.js';
import { readConfig } from './config.js';
import { ensureLink, linkBody, toReference, type LinkRequest } from './links.js';

/**
 * `pnpm razorpay` — turn decisions the engine already made into real Razorpay Payment Links.
 *
 * WHAT THIS DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT.
 *
 * It reads the `payment_link` decisions from a completed run and issues each one as a real
 * link in Razorpay test mode. It does not decide anything. It does not touch the evaluation,
 * the simulator, the policy, or a single number in the report.
 *
 * That separation is deliberate and it is the whole reason this is safe to add three days
 * before a deadline. The measured claim — a share of an achievable ceiling — requires an
 * oracle playing perfectly against known ground truth, and ground truth only exists in a world
 * somebody wrote down. Against a live gateway there is no ceiling, so there is no such claim
 * to make. Swapping the simulator for Razorpay would not strengthen the result; it would
 * delete it.
 *
 * So the two answer different questions, and both are worth answering:
 *
 *   The simulator answers "how good are these decisions?" — measurably, against a bound.
 *   Razorpay answers "are these decisions real?" — by executing one.
 *
 * `--dry-run` prints the exact JSON that would be POSTed and calls nothing. It is the default
 * when no keys are present, so the integration is inspectable on a laptop with no credentials
 * and no network.
 */

const USAGE = `
  pnpm razorpay [options]

    --limit N      how many links to issue          (default 5)
    --seed N       which run to read                (default EVAL_SEED or 42)
    --dry-run      print the JSON, call nothing     (default when keys are absent)
    --live         actually call Razorpay test mode (requires keys)
`;

interface Args {
  readonly limit: number;
  readonly seed: number;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Set(argv.filter((token) => token.startsWith('--')));
  const valueOf = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };

  if (flags.has('--help')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const limit = Number.parseInt(valueOf('limit') ?? '5', 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError(`--limit must be between 1 and 50, got ${valueOf('limit') ?? ''}`);
  }

  const seedRaw = valueOf('seed') ?? process.env['EVAL_SEED'] ?? '42';
  const seed = Number.parseInt(seedRaw, 10);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new RangeError(`--seed must be a non-negative integer, got ${seedRaw}`);
  }

  // `--live` is required to opt IN. A missing flag means dry-run, so the failure mode of
  // forgetting a flag is "printed some JSON" rather than "sent demands for money".
  return { limit, seed, dryRun: !flags.has('--live') };
}

/**
 * The decisions worth showing: fired `payment_link` steps, highest expected recovery first.
 *
 * Ordered by expected recovery rather than by amount, because that is the quantity the engine
 * actually acted on — and showing the largest INVOICE would misrepresent the system as an
 * amount-chaser when its whole argument is that it chases expected value.
 */
async function loadLinkDecisions(
  db: ReturnType<typeof createDb>['db'],
  args: Args,
): Promise<
  readonly {
    readonly decisionId: string;
    readonly txnId: string;
    readonly key: string;
    readonly reasonCode: string;
    readonly riskClass: string;
    readonly amount: Paise;
    readonly expected: Paise;
    readonly customerName: string;
    readonly customerRef: string;
  }[]
> {
  const rows = await db
    .selectFrom('decision')
    .innerJoin('batch', 'batch.id', 'decision.batch_id')
    .innerJoin('txn', 'txn.id', 'decision.txn_id')
    .innerJoin('customer', 'customer.id', 'txn.customer_id')
    .select([
      'decision.id as decision_id',
      'decision.txn_id as txn_id',
      'decision.idempotency_key as idempotency_key',
      'decision.reason_code as reason_code',
      'decision.ev_p_bps as ev_p_bps',
      'decision.ev_value_paise as ev_value_paise',
      'txn.risk_class as risk_class',
      'txn.amount_paise as amount_paise',
      'customer.display_name as display_name',
      'customer.external_ref as external_ref',
    ])
    .where('batch.seed', '=', args.seed)
    .where('batch.arm', '=', 'rc')
    .where('batch.world', '=', 'base')
    .where('decision.verdict', '=', 'fire')
    .where('decision.planned_action', '=', 'payment_link')
    .execute();

  return rows
    .map((row) => ({
      decisionId: row.decision_id,
      txnId: row.txn_id,
      // Non-null for a fired decision, enforced by `decision_fire_is_identified`. Falling
      // back to the decision id rather than asserting, because a missing key here should
      // degrade to a still-unique reference rather than crash a demo.
      key: row.idempotency_key ?? row.decision_id,
      reasonCode: row.reason_code,
      riskClass: row.risk_class,
      amount: PaiseSchema.parse(row.amount_paise),
      expected: mulBps(PaiseSchema.parse(row.ev_value_paise), bps(row.ev_p_bps)),
      customerName: row.display_name,
      customerRef: row.external_ref,
    }))
    .sort((a, b) => (b.expected > a.expected ? 1 : b.expected < a.expected ? -1 : 0))
    .slice(0, args.limit);
}

/**
 * A test-mode contact for a synthetic customer.
 *
 * Razorpay validates the shape of a phone number, and these customers do not have one — they
 * were invented by a simulator. So a deterministic number in the reserved 99xxx test range is
 * derived from the customer's own reference: stable across runs, obviously fake, and belonging
 * to nobody. `notify` is off, so nothing is sent to it in any case.
 */
function testContact(customerRef: string): string {
  let hash = 0;
  for (const char of customerRef) hash = (hash * 31 + char.charCodeAt(0)) % 100_000_000;
  return `+9199${String(hash).padStart(8, '0')}`;
}

/** What the customer sees. Names the cause, because a link with no context reads as a scam. */
function describe(reasonCode: string, riskClass: string): string {
  const subject =
    riskClass === 'checkout_abandonment'
      ? 'your incomplete order'
      : riskClass === 'receivable_overdue'
        ? 'your outstanding invoice'
        : 'your payment';
  return `Complete ${subject} — ${reasonCode.replace(/_/g, ' ')} [test mode]`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { db, close } = createDb();

  try {
    const decisions = await loadLinkDecisions(db, args);

    process.stdout.write(
      `\n  Razorpay Payment Links — seed ${args.seed}, arm rc\n` +
        `  ${args.dryRun ? 'DRY RUN — nothing is sent' : 'LIVE — Razorpay test mode'}\n\n`,
    );

    if (decisions.length === 0) {
      process.stdout.write(
        `  No fired payment_link decisions found for seed ${args.seed}.\n` +
          `  Run \`pnpm demo\` first, then try again.\n\n`,
      );
      return;
    }

    const config = readConfig();

    if (!args.dryRun && !config.ok) {
      process.stdout.write(
        `  Cannot run live: Razorpay credentials are missing or invalid.\n\n` +
          `    ${config.problem ?? 'unknown'}\n\n` +
          `  Add these to .env and try again:\n\n` +
          `    RAZORPAY_KEY_ID=rzp_test_...\n` +
          `    RAZORPAY_KEY_SECRET=...\n\n` +
          `  Falling back to a dry run.\n\n`,
      );
    }

    const live = !args.dryRun && config.ok && config.config !== undefined;
    let issued = 0;
    let reused = 0;
    let failed = 0;

    for (const decision of decisions) {
      const reference = toReference(decision.key);
      const link: LinkRequest = {
        referenceId: reference,
        amount: decision.amount,
        description: describe(decision.reasonCode, decision.riskClass),
        customerName: decision.customerName,
        customerContact: testContact(decision.customerRef),
        customerEmail: 'test@recovery-controller.invalid',
        notify: false,
        notes: {
          txn_id: decision.txnId,
          decision_id: decision.decisionId,
          risk_class: decision.riskClass,
          reason_code: decision.reasonCode,
        },
      };

      process.stdout.write(
        `  ${decision.riskClass.padEnd(22)} ${decision.reasonCode.padEnd(22)} ` +
          `${formatINR(decision.amount).padStart(13)}  ` +
          `expected ${formatINR(decision.expected).padStart(11)}\n`,
      );

      if (!live || config.config === undefined) {
        process.stdout.write(
          `    POST /payment_links ${JSON.stringify(linkBody(link))}\n\n`,
        );
        continue;
      }

      try {
        const result = await ensureLink(config.config, link);
        if (result.reused) reused += 1;
        else issued += 1;
        process.stdout.write(
          `    ${result.reused ? 'already existed' : 'created'}  ${result.link.short_url}\n` +
            `    status ${result.link.status} · ref ${reference}\n\n`,
        );
      } catch (cause) {
        failed += 1;
        const message = cause instanceof RazorpayError ? cause.message : String(cause);
        process.stdout.write(`    FAILED  ${message}\n\n`);
      }
    }

    if (live) {
      process.stdout.write(
        `  ${issued} created · ${reused} already existed · ${failed} failed\n\n` +
          `  The "already existed" count is the point, on a second run: reference_id carries\n` +
          `  the engine's derived idempotency key, so Razorpay refuses to create a second\n` +
          `  demand for the same money. Run this again and every link should be reused.\n\n`,
      );
    } else {
      process.stdout.write(
        `  ${decisions.length} link(s) would be created. Nothing was sent.\n` +
          `  Add Razorpay test keys to .env and pass --live to issue them.\n\n`,
      );
    }
  } finally {
    await close();
  }
}

await main();
