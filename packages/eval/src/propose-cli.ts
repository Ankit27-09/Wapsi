import {
  changeIsInRange,
  createProposer,
  isPricedModel,
  resolveProvider,
  type ProposedChange,
} from '@rc/ai';
import { formatINR, paise } from '@rc/core';
import { createDb, type Db } from '@rc/db';
import { buildPolicy, loadPolicy, loadPriorTable, type Policy } from '@rc/policy';
import { loadTruthModel } from '@rc/simulator';
import { applyChanges } from './apply-policy.js';
import { armById } from './arms.js';
import { gatherEvidence } from './evidence.js';
import { authorise } from './operator.js';
import {
  decide,
  loadAwaiting,
  loadById,
  storeProposals,
  type StoredProposal,
} from './proposals.js';
import { simulateArm } from './sweep.js';

/**
 * `pnpm propose` — the bounded policy-improvement loop.
 *
 * Three modes, and the separation matters:
 *
 *   pnpm propose                   generate proposals and store them for review
 *   pnpm propose --approve 3       apply proposal 3, evaluate it on a held-out seed
 *   pnpm propose --reject 4 --note "…"   record a rejection with a reason
 *
 * Generation and decision are DIFFERENT COMMANDS against STORED rows, because the agent is
 * not deterministic: regenerating at approval time would approve something nobody read,
 * which is the precise failure the human gate exists to prevent.
 *
 * Approved changes are evaluated on a held-out seed. A change tuned on one batch that only
 * helps that batch has learned the noise, and reporting its improvement would be reporting
 * an overfit.
 */

interface Args {
  readonly seed: number;
  readonly holdoutSeed: number;
  readonly count: number;
  readonly approve: number | null;
  readonly reject: number | null;
  readonly note: string;
  readonly operator: string;
  readonly token: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} expects a value`);
    flags.set(token.slice(2), value);
  }

  const asId = (key: string): number | null => {
    const raw = flags.get(key);
    if (raw === undefined) return null;
    const id = Number.parseInt(raw, 10);
    if (!Number.isInteger(id)) throw new Error(`--${key} expects a proposal id`);
    return id;
  };

  return {
    seed: Number.parseInt(flags.get('seed') ?? process.env['EVAL_SEED'] ?? '42', 10),
    // A DIFFERENT seed on purpose. Evaluating a change on the batch that suggested it
    // measures how well it fits the past, which is not the question.
    holdoutSeed: Number.parseInt(flags.get('holdout') ?? '99', 10),
    count: Number.parseInt(flags.get('count') ?? '300', 10),
    approve: asId('approve'),
    reject: asId('reject'),
    note: flags.get('note') ?? '',
    operator: flags.get('operator') ?? 'human:operator',
    // Falls back to the environment so a shell that already exports it does not have to
    // repeat it on the command line — and so the secret stays out of shell history.
    token: flags.get('token') ?? process.env['OPERATOR_TOKEN_PRESENTED'],
  };
}

/**
 * Halt unless the caller holds the operator secret.
 *
 * Exits rather than throwing, so an unauthorised attempt produces the instruction the reader
 * needs instead of a stack trace with the reason buried in it.
 */
function requireOperator(args: Args, action: string): void {
  const auth = authorise({ presented: args.token, operator: args.operator });
  if (auth.ok) return;

  process.stderr.write(
    `\n  REFUSED — not authorised to ${action}.\n\n    ${auth.problem}\n\n` +
      `  This gate exists because the whole safety argument of this loop is "the agent\n` +
      `  proposes, a human decides". Without a credential that is a convention, not a\n` +
      `  control: the audit row would say a human approved and be unable to establish it.\n\n`,
  );
  process.exit(1);
}

function describe(policy: Policy, stored: StoredProposal): string {
  const change = stored.change;
  const target =
    change.reason_code === null ? change.field : `${change.reason_code}.${change.field}`;
  const current = currentValue(policy, change);

  return (
    `  [${stored.id}] ${target}: ${current} → ${change.to_value}` +
    `   (confidence ${(stored.confidenceBps / 100).toFixed(0)}%)\n` +
    `       ${stored.rationale.split('\n')[0] ?? ''}\n`
  );
}

function currentValue(policy: Policy, change: ProposedChange): number {
  return change.field === 'ev_floor_paise'
    ? Number(policy.evFloor)
    : policy.forReason(change.reason_code ?? 'insufficient_funds').min_gap_hours;
}

function evaluateOnHoldout(
  args: Args,
  policyText: string,
  label: string,
): { readonly net: bigint; readonly fired: number; readonly recovered: number } {
  const candidate = buildPolicy(policyText);
  const result = simulateArm({
    seed: args.holdoutSeed,
    count: args.count,
    policy: candidate,
    priors: loadPriorTable(),
    truth: loadTruthModel(),
    arm: armById('rc'),
  });

  process.stdout.write(
    `    ${label.padEnd(26)} ${formatINR(result.net).padStart(14)}  ` +
      `${result.fired} fired, ${result.recovered} recovered\n`,
  );

  return { net: result.net, fired: result.fired, recovered: result.recovered };
}

// ---------------------------------------------------------------------------

async function generate(db: Db, args: Args, policy: Policy): Promise<void> {
  const resolution = resolveProvider();

  if (resolution.provider === null) {
    process.stdout.write(
      `\n  The proposal agent cannot run: ${resolution.problem ?? 'no provider'}\n\n` +
        `  The bounded-change mechanism is still real and testable without it: see\n` +
        `  packages/ai/src/proposer.ts, where the safety bounds are absent from the\n` +
        `  output schema rather than merely discouraged in the prompt.\n\n`,
    );
    return;
  }

  const provider = resolution.provider;
  if (!isPricedModel(provider.model)) {
    throw new Error(
      `LLM_MODEL is "${provider.model}", which has no published price in @rc/ai/cost.ts.`,
    );
  }

  const evidence = await gatherEvidence(db, { seed: args.seed, arm: 'rc', world: 'base' });
  process.stdout.write(
    `  ${evidence.decisions} decisions summarised for ${provider.id}:${provider.model}.\n\n`,
  );

  const proposer = createProposer({
    provider,
    usdInrPaise: Number.parseInt(process.env['USD_INR_PAISE'] ?? '8800', 10),
  });

  const result = await proposer.propose({
    policyVersion: policy.version,
    batchSummary: evidence.summary,
    tunables: tunablesFor(policy),
  });

  if (result.proposal === null) {
    process.stdout.write(`  The agent produced no usable proposal: ${result.error}\n\n`);
    return;
  }

  process.stdout.write(`  ${result.proposal.summary}\n\n`);

  // Range-checked BEFORE storage. A proposal outside the clamps never reaches a reviewer,
  // which keeps the queue to things a human could actually accept.
  const admissible = result.proposal.changes.filter((change) => {
    const check = changeIsInRange(change, policy.tunableRange(change.field));
    if (!check.ok) {
      process.stdout.write(
        `  DISCARDED before review — ${change.field}: ${check.reason}\n`,
      );
    }
    return check.ok;
  });

  if (admissible.length === 0) {
    process.stdout.write(`\n  Nothing admissible. The policy is unchanged.\n\n`);
    return;
  }

  const stored = await storeProposals(db, {
    policy,
    batchId: null,
    changes: admissible,
    predictedNetDeltaPaise: result.proposal.predicted_net_delta_paise,
    confidenceBps: result.confidenceBps,
  });

  process.stdout.write(
    `  Predicted net delta ${formatINR(paise(BigInt(result.proposal.predicted_net_delta_paise)))}, ` +
      `agent cost ${formatINR(result.costPaise)}\n\n`,
  );

  for (const proposal of stored) {
    process.stdout.write(describe(policy, proposal));
  }

  process.stdout.write(
    `\n  Stored for review. Decide by id — the ids are stable, so you approve what you read:\n` +
      `    pnpm propose --approve ${stored[0]?.id ?? 1}\n` +
      `    pnpm propose --reject ${stored[0]?.id ?? 1} --note "why"\n\n`,
  );
}

async function approve(db: Db, args: Args, policy: Policy, id: number): Promise<void> {
  // AUTHORISED BEFORE ANYTHING IS READ OR EVALUATED. Checking after the held-out run would
  // mean an unauthorised caller could still make the system spend a minute of compute and
  // print the result of a change they were not permitted to make.
  requireOperator(args, `approve proposal ${id}`);

  const proposal = await loadById(db, id);
  if (proposal === null) throw new Error(`No proposal ${id}. Run \`pnpm propose\` first.`);
  if (proposal.status !== 'awaiting') {
    throw new Error(`Proposal ${id} is already ${proposal.status}.`);
  }

  process.stdout.write(`\n  Approving:\n${describe(policy, proposal)}\n`);

  const nextYaml = applyChanges(policy, [proposal.change]);
  const nextVersion = policy.version + 1;

  process.stdout.write(`  Held-out evaluation (seed ${args.holdoutSeed})\n\n`);
  const before = evaluateOnHoldout(args, policy.yaml, `v${policy.version} (current)`);
  const after = evaluateOnHoldout(args, nextYaml, `v${nextVersion} (approved)`);

  const delta = after.net - before.net;

  await decide(db, {
    id,
    status: 'approved',
    by: args.operator,
    note: args.note === '' ? 'approved after held-out evaluation' : args.note,
    at: new Date(),
    // `applied_version` stays unset: approval records a decision, not a deployment. The
    // policy file is only rewritten when a human commits the diff, and that is when a new
    // version row exists to point at.
  });

  process.stdout.write(
    `\n  Measured delta on unseen data: ${formatINR(paise(delta))}` +
      ` against a predicted ${formatINR(paise(proposal.predictedNetDeltaPaise))}.\n`,
  );

  if (delta === 0n) {
    process.stdout.write(
      `\n  EXACTLY ZERO. The change applied — the policy text really did change — and it\n` +
        `  altered nothing about behaviour. That is a finding, not a failure of the\n` +
        `  measurement, and it is why an approved change is evaluated before it is trusted.\n`,
    );
  }

  process.stdout.write(
    `\n  Recorded as approved by ${args.operator}. The policy file is NOT rewritten\n` +
      `  automatically: a human applies the diff, which keeps the file under review.\n\n`,
  );
}

async function reject(db: Db, args: Args, policy: Policy, id: number): Promise<void> {
  // A rejection is gated too, and that is not symmetry for its own sake. An unauthorised
  // party who could reject proposals could suppress every improvement the agent found while
  // leaving an audit trail that says a human considered and declined each one.
  requireOperator(args, `reject proposal ${id}`);

  const proposal = await loadById(db, id);
  if (proposal === null) throw new Error(`No proposal ${id}.`);

  await decide(db, {
    id,
    status: 'rejected',
    by: args.operator,
    note: args.note === '' ? 'rejected by operator' : args.note,
    at: new Date(),
  });

  process.stdout.write(
    `\n  Rejected:\n${describe(policy, proposal)}\n` +
      `  Reason: ${args.note === '' ? '(none given)' : args.note}\n` +
      `  Recorded against ${args.operator}. A rejection is as much a part of the audit\n` +
      `  trail as an approval — it is the evidence the human gate is real.\n\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { db, close } = createDb();
  const policy = loadPolicy();

  try {
    if (args.approve !== null) {
      await approve(db, args, policy, args.approve);
      return;
    }
    if (args.reject !== null) {
      await reject(db, args, policy, args.reject);
      return;
    }

    process.stdout.write(
      `\n  Policy proposal — reading seed ${args.seed}, policy v${policy.version}\n` +
        `  Changes will be evaluated on held-out seed ${args.holdoutSeed}.\n\n`,
    );

    const awaiting = await loadAwaiting(db);
    if (awaiting.length > 0) {
      process.stdout.write(`  ${awaiting.length} proposal(s) already awaiting a decision:\n\n`);
      for (const proposal of awaiting) process.stdout.write(describe(policy, proposal));
      process.stdout.write(
        `\n  Decide these before generating more, or they will queue up behind each other.\n\n`,
      );
      return;
    }

    await generate(db, args, policy);
  } finally {
    await close();
  }
}

/** Current values and clamps, so the agent proposes inside the permitted ranges. */
function tunablesFor(policy: Policy): Parameters<
  ReturnType<typeof createProposer>['propose']
>[0]['tunables'] {
  const gapRange = policy.tunableRange('min_gap_hours');
  const floorRange = policy.tunableRange('ev_floor_paise');
  if (gapRange === undefined || floorRange === undefined) {
    throw new Error('Policy is missing tunable ranges for min_gap_hours or ev_floor_paise');
  }

  // Only codes whose schedule permits a SECOND attempt. `min_gap_hours` binds from attempt
  // two onward, so offering it for a single-attempt code invites a proposal that is legal,
  // in range, and completely inert — which is exactly what happened before this filter
  // existed, and cost a held-out evaluation to discover.
  const gapTunable = (['insufficient_funds', 'issuer_down', 'threeds_timeout'] as const)
    .filter((code) => policy.attemptCap(code) >= 2)
    .map((code) => ({
      field: 'min_gap_hours' as const,
      reasonCode: code,
      current: policy.forReason(code).min_gap_hours,
      min: gapRange.min,
      max: gapRange.max,
    }));

  return [
    ...gapTunable,
    {
      field: 'ev_floor_paise' as const,
      reasonCode: null,
      current: Number(policy.evFloor),
      min: floorRange.min,
      max: floorRange.max,
    },
  ];
}

await main();
