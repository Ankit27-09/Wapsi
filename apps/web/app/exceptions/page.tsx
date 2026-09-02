import Link from 'next/link';
import { formatINR } from '@rc/core';
import { loadExceptions, seedFrom } from '../../lib/queries';
import { SeedPicker } from '../seed-picker';

const VERDICTS = [
  { key: 'all', label: 'all' },
  { key: 'refuse_ev', label: 'expected value' },
  { key: 'refuse_bounds', label: 'bounds' },
  { key: 'refuse_terminal', label: 'terminal' },
  { key: 'refuse_kill_switch', label: 'kill switch' },
] as const;

function verdictClass(verdict: string): string {
  if (verdict === 'refuse_terminal') return 'pill bad';
  if (verdict === 'refuse_ev') return 'pill warn';
  if (verdict === 'refuse_kill_switch') return 'pill bad';
  return 'pill';
}

export default async function Exceptions({
  searchParams,
}: {
  searchParams: Promise<{ verdict?: string; seed?: string }>;
}) {
  const params = await searchParams;
  const active = params.verdict ?? 'all';
  const seed = seedFrom(params.seed);
  const rows = await loadExceptions(seed, active);

  return (
    <>
      <SeedPicker current={seed} path="/exceptions" />

      <div className="page-head">
        <h2>Exception queue</h2>
        <p>
          Every action the controller refused to take, with the arithmetic that produced the
          refusal. This is the page most systems do not have: a refusal that cannot say what
          it would have been worth is a log line, and one that can is an audit record.
        </p>
      </div>

      <div className="filters">
        {VERDICTS.map((verdict) => (
          <Link
            key={verdict.key}
            href={verdict.key === 'all' ? '/exceptions' : `/exceptions?verdict=${verdict.key}`}
            data-active={active === verdict.key ? 'true' : 'false'}
          >
            {verdict.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          Nothing refused under this filter. Run <code className="mono">pnpm demo</code> if the
          database is empty.
        </div>
      ) : (
        <div className="wrap">
          <table>
            <thead>
              <tr>
                <th>Cause</th>
                <th>Verdict</th>
                <th>p</th>
                <th>At stake</th>
                <th>Cost</th>
                <th>Net</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.reasonCode}</td>
                  <td>
                    <span className={verdictClass(row.verdict)}>
                      {row.verdict.replace('refuse_', '')}
                    </span>
                  </td>
                  <td className="dim">{(row.pBps / 100).toFixed(1)}%</td>
                  <td>{formatINR(row.value)}</td>
                  <td className="dim">{formatINR(row.cost)}</td>
                  <td className={row.net < 0n ? 'bad' : undefined}>{formatINR(row.net)}</td>
                  <td className="detail">{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="callout">
        <strong>Read the “at stake” and “net” columns together.</strong> A transaction can be
        worth thousands and still be correctly refused: an expired card has a success
        probability of exactly zero, so no amount of value at stake justifies a fee. That is
        the difference between a system that stops because it ran out of retries and one that
        stops because trying does not pay — and it is why the gate multiplies by contribution
        margin rather than by the transaction amount.
      </div>
    </>
  );
}
