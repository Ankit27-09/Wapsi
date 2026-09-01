import { formatINR, paise } from '@rc/core';
import { db } from '../../lib/db';

interface ProposalRow {
  readonly id: number;
  readonly diff: unknown;
  readonly rationale: string;
  readonly predicted: string;
  readonly confidenceBps: number;
  readonly status: string;
  readonly decidedBy: string | null;
  readonly note: string | null;
}

/**
 * The bounded improvement loop, as a reviewer sees it.
 *
 * The safety property is the proposal SCHEMA, not the prompt: the agent cannot suggest
 * relaxing the kill switch, widening quiet hours, raising the contact ceiling or weakening
 * consent, because those fields do not exist in the type it emits. A prompt asking it not to
 * is a request; a schema without the fields is a guarantee.
 */
export default async function Policy() {
  const versions = await db()
    .selectFrom('policy_version')
    .select(['version', 'hash', 'approved_by', 'approved_at'])
    .orderBy('version', 'desc')
    .execute();

  const proposals = (await db()
    .selectFrom('policy_proposal')
    .select([
      'id',
      'diff',
      'rationale',
      'predicted_net_delta_paise as predicted',
      'confidence_bps as confidenceBps',
      'status',
      'decided_by as decidedBy',
      'decision_note as note',
    ])
    .orderBy('id', 'desc')
    .limit(20)
    .execute()) as unknown as ProposalRow[];

  return (
    <>
      <div className="page-head">
        <h2>Policy</h2>
        <p>
          Bounds live as versioned data, not scattered through code. Every decision records
          the policy version that governed it, so the exact rules in force when an action was
          taken are one lookup away.
        </p>
      </div>

      <h3>Versions</h3>
      <div className="wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Hash</th>
              <th>Approved by</th>
            </tr>
          </thead>
          <tbody>
            {versions.length === 0 ? (
              <tr>
                <td colSpan={3} className="dim" style={{ textAlign: 'left' }}>
                  No versions recorded yet — run <span className="mono">pnpm propose</span>.
                </td>
              </tr>
            ) : (
              versions.map((version) => (
                <tr key={version.version}>
                  <td className="mono">v{version.version}</td>
                  <td className="mono dim">{version.hash.slice(0, 16)}</td>
                  <td className="mono dim">{version.approved_by}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h3>Proposal queue</h3>
      {proposals.length === 0 ? (
        <div className="empty">
          No proposals. Run <code className="mono">pnpm propose</code> after a batch.
        </div>
      ) : (
        <div className="wrap">
          <table>
            <thead>
              <tr>
                <th>Change</th>
                <th>Confidence</th>
                <th>Predicted</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((proposal) => {
                const change = proposal.diff as {
                  field?: string;
                  reason_code?: string | null;
                  from_value?: number;
                  to_value?: number;
                };
                const target =
                  change.reason_code == null
                    ? (change.field ?? '?')
                    : `${change.reason_code}.${change.field ?? '?'}`;

                return (
                  <tr key={proposal.id}>
                    <td>
                      <div className="mono">
                        [{proposal.id}] {target}: {change.from_value} → {change.to_value}
                      </div>
                      <div className="detail" style={{ marginTop: 5 }}>
                        {proposal.rationale.split('\n')[0]}
                      </div>
                      {proposal.note !== null && (
                        <div className="detail warn" style={{ marginTop: 4 }}>
                          decision: {proposal.note}
                        </div>
                      )}
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      {(proposal.confidenceBps / 100).toFixed(0)}%
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      {formatINR(paise(BigInt(proposal.predicted)))}
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      <span
                        className={
                          proposal.status === 'approved'
                            ? 'pill good'
                            : proposal.status === 'rejected'
                              ? 'pill bad'
                              : 'pill warn'
                        }
                      >
                        {proposal.status}
                      </span>
                      {proposal.decidedBy !== null && (
                        <div className="dim mono" style={{ fontSize: 10, marginTop: 4 }}>
                          {proposal.decidedBy}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="callout">
        <strong>The agent proposes; a person decides.</strong> Approved changes are measured
        on a <em>held-out seed</em> before they are believed — a change tuned on one batch
        that only helps that batch has learned the noise. One approved proposal here predicted
        +₹2,067 and measured −₹11,935 on unseen data, which is exactly why the step exists.
      </div>
    </>
  );
}
