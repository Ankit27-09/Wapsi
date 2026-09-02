import { loadAudit, seedFrom } from '../../lib/queries';
import { SeedPicker } from '../seed-picker';

function actorClass(actor: string): string {
  if (actor.startsWith('llm:')) return 'pill accent';
  if (actor.startsWith('human:')) return 'pill warn';
  return 'pill';
}

/**
 * The append-only trail.
 *
 * `actor` is the column that matters. It separates the deterministic policy engine from the
 * model from the human, which is what lets "did an LLM decide this?" be answered by a query
 * rather than by reading source. In this system the answer is always no for anything
 * involving money — and this page is how that is demonstrated rather than asserted.
 */
export default async function Audit({
  searchParams,
}: {
  searchParams: Promise<{ trace?: string; seed?: string }>;
}) {
  const params = await searchParams;
  const trace = params.trace ?? '';
  const seed = seedFrom(params.seed);
  const rows = await loadAudit(seed, trace);

  const actors = new Map<string, number>();
  for (const row of rows) actors.set(row.actor, (actors.get(row.actor) ?? 0) + 1);

  return (
    <>
      <SeedPicker current={seed} path="/audit" />

      <div className="page-head">
        <h2>Audit trail</h2>
        <p>
          Append-only, enforced by a database trigger rather than by convention — updates,
          deletes and truncates are all rejected. Every action <em>and every refusal</em>
          writes a row.
        </p>
      </div>

      <div className="tiles">
        {[...actors.entries()].map(([actor, count]) => (
          <div className="tile" key={actor}>
            <div className="label">{actor}</div>
            <div className="value">{count}</div>
            <div className="note">events</div>
          </div>
        ))}
      </div>

      {trace !== '' && (
        <div className="callout">
          Filtered to trace <code className="mono">{trace}</code>.
        </div>
      )}

      <h3>Most recent {rows.length} events</h3>
      {rows.length === 0 ? (
        <div className="empty">
          Nothing recorded. Run <code className="mono">pnpm demo</code> first.
        </div>
      ) : (
        <div className="wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Actor</th>
                <th>Policy</th>
                <th>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.eventType}</td>
                  <td>
                    <span className={actorClass(row.actor)}>{row.actor}</span>
                  </td>
                  <td className="dim">v{row.policyVersion ?? '—'}</td>
                  <td className="detail">{row.rationale ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="callout">
        <strong>Note the actors.</strong> Every row touching money is attributed to{' '}
        <code className="mono">policy_engine</code> or <code className="mono">worker</code> —
        deterministic code. The model appears only where it classified a failure string, and
        a human appears only where one approved or rejected a policy change. That separation
        is the whole claim, and it is queryable rather than promised.
      </div>
    </>
  );
}
