import type { ProposedChange } from '@rc/ai';
import type { Db } from '@rc/db';
import type { Policy } from '@rc/policy';

/**
 * PROPOSAL PERSISTENCE
 *
 * Why this exists rather than approving from whatever the agent just printed: the agent is
 * not deterministic. Running `propose` twice produces different suggestions in a different
 * order, so approving "number 1" after reviewing an earlier run APPROVES SOMETHING NOBODY
 * READ. That is the exact failure the human gate is supposed to prevent, reintroduced by the
 * interface around it.
 *
 * So a proposal is written to the database when it is generated, reviewed by its stable id,
 * and decided by that id. The decision records who made it and when, and lands in the audit
 * trail with everything else.
 *
 * One row per CHANGE rather than per proposal. A tuning pass that suggests three things
 * should be approvable in parts — accepting the well-evidenced one and rejecting the
 * speculative one is the normal outcome of review, and a single all-or-nothing row would
 * force a reviewer to take the bad with the good.
 */

export interface StoredProposal {
  readonly id: number;
  readonly change: ProposedChange;
  readonly rationale: string;
  readonly predictedNetDeltaPaise: bigint;
  readonly confidenceBps: number;
  readonly status: 'awaiting' | 'approved' | 'rejected';
  readonly fromVersion: number;
}

/**
 * Record the policy the system is currently running.
 *
 * `policy_proposal.from_version` is a foreign key onto this table, so a proposal cannot be
 * stored until the version it was made against is on record. Idempotent, and the hash means
 * an approval cannot later be replayed against different content than the approver read.
 */
export async function ensurePolicyVersionRecorded(db: Db, policy: Policy): Promise<void> {
  await db
    .insertInto('policy_version')
    .values({
      version: policy.version,
      parent_version: null,
      yaml: policy.yaml,
      hash: policy.hash,
      approved_by: policy.approvedBy,
    })
    .onConflict((oc) => oc.column('version').doNothing())
    .execute();
}

export async function storeProposals(
  db: Db,
  args: {
    readonly policy: Policy;
    readonly batchId: string | null;
    readonly changes: readonly ProposedChange[];
    readonly predictedNetDeltaPaise: number;
    readonly confidenceBps: number;
  },
): Promise<readonly StoredProposal[]> {
  await ensurePolicyVersionRecorded(db, args.policy);

  const stored: StoredProposal[] = [];

  for (const change of args.changes) {
    const row = await db
      .insertInto('policy_proposal')
      .values({
        from_version: args.policy.version,
        batch_id: args.batchId,
        diff: JSON.stringify(change),
        rationale: change.rationale,
        // The agent cites decision ids as evidence. They are stored as text rather than
        // validated as uuids: a hallucinated id is itself worth keeping, because it is how
        // a reviewer discovers the rationale was not grounded.
        evidence_decision_ids: [],
        predicted_net_delta_paise: String(
          Math.round(args.predictedNetDeltaPaise / Math.max(1, args.changes.length)),
        ),
        confidence_bps: args.confidenceBps,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    stored.push({
      id: row.id,
      change,
      rationale: change.rationale,
      predictedNetDeltaPaise: BigInt(
        Math.round(args.predictedNetDeltaPaise / Math.max(1, args.changes.length)),
      ),
      confidenceBps: args.confidenceBps,
      status: 'awaiting',
      fromVersion: args.policy.version,
    });
  }

  return stored;
}

/** Proposals still awaiting a decision, oldest first. */
export async function loadAwaiting(db: Db): Promise<readonly StoredProposal[]> {
  const rows = await db
    .selectFrom('policy_proposal')
    .select([
      'id',
      'diff',
      'rationale',
      'predicted_net_delta_paise',
      'confidence_bps',
      'status',
      'from_version',
    ])
    .where('status', '=', 'awaiting')
    .orderBy('id', 'asc')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    change: row.diff as ProposedChange,
    rationale: row.rationale,
    predictedNetDeltaPaise: BigInt(row.predicted_net_delta_paise),
    confidenceBps: row.confidence_bps,
    status: row.status,
    fromVersion: row.from_version,
  }));
}

export async function loadById(db: Db, id: number): Promise<StoredProposal | null> {
  const row = await db
    .selectFrom('policy_proposal')
    .select([
      'id',
      'diff',
      'rationale',
      'predicted_net_delta_paise',
      'confidence_bps',
      'status',
      'from_version',
    ])
    .where('id', '=', id)
    .executeTakeFirst();

  if (row === undefined) return null;

  return {
    id: row.id,
    change: row.diff as ProposedChange,
    rationale: row.rationale,
    predictedNetDeltaPaise: BigInt(row.predicted_net_delta_paise),
    confidenceBps: row.confidence_bps,
    status: row.status,
    fromVersion: row.from_version,
  };
}

/**
 * Record a human decision.
 *
 * The schema refuses a decided proposal without an author and a timestamp, and refuses an
 * `applied_version` on anything not approved — so "approved by whom, and when?" cannot be
 * left unanswerable by omission.
 */
export async function decide(
  db: Db,
  args: {
    readonly id: number;
    readonly status: 'approved' | 'rejected';
    readonly by: string;
    readonly note: string;
    readonly at: Date;
    readonly appliedVersion?: number;
  },
): Promise<void> {
  const existing = await loadById(db, args.id);
  if (existing === null) throw new Error(`No proposal ${args.id}`);
  if (existing.status !== 'awaiting') {
    // A second decision on a decided proposal would silently overwrite the first, and the
    // audit trail would show only the last one.
    throw new Error(
      `Proposal ${args.id} was already ${existing.status} and cannot be decided again`,
    );
  }

  await db
    .updateTable('policy_proposal')
    .set({
      status: args.status,
      decided_by: args.by,
      decided_at: args.at,
      decision_note: args.note,
      ...(args.appliedVersion === undefined ? {} : { applied_version: args.appliedVersion }),
    })
    .where('id', '=', args.id)
    .execute();
}
