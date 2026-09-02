import { ZERO, formatINR, sub } from '@rc/core';
import { loadArms, loadByReasonCode, loadByRiskClass, SEED } from '../lib/queries';

function rate(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

function shareOf(value: bigint, reference: bigint): string {
  if (reference === 0n) return '—';
  return `${(Number((value * 10_000n) / reference) / 100).toFixed(1)}%`;
}

export default async function Overview() {
  const arms = await loadArms();

  if (arms.length === 0) {
    return (
      <div className="empty">
        No run found for seed {SEED}. Run <code className="mono">pnpm demo</code> first.
      </div>
    );
  }

  const rc = arms.find((a) => a.arm === 'rc');
  const ceiling = arms.find((a) => a.arm === 'b3_oracle');

  // Seeded from the FILTERED list, not from `arms[0]`.
  //
  // The reduce previously started at `arms[0]!` — whichever arm the query happened to return
  // first, which is `b0` in practice but could be the controller or the oracle. Since the
  // seed participates in the comparison, "best baseline" could have reported the
  // controller's own net value as the bar it beat. The non-null assertion is what let that
  // through review: it silenced the question of what happens when there are no baselines.
  const baselines = arms.filter((a) => a.arm !== 'rc' && a.arm !== 'b3_oracle');
  const bestBaseline = baselines.reduce<(typeof baselines)[number] | undefined>(
    (best, a) => (best === undefined || a.net > best.net ? a : best),
    undefined,
  );

  const byClass = await loadByRiskClass();
  const byCode = await loadByReasonCode();
  const maxActivity = Math.max(...byCode.map((c) => c.fired + c.refused), 1);

  return (
    <>
      <div className="page-head">
        <h2>Overview</h2>
        <p>
          Every arm run over an identical seeded population, so a difference between them is
          a difference in strategy rather than in luck. Net value is contribution margin
          recovered minus every rupee spent getting it.
        </p>
      </div>

      <div className="tiles">
        <div className="tile primary">
          <div className="label">Net value</div>
          <div className="value">{formatINR(rc?.net ?? ZERO)}</div>
          <div className="note">Recovery Controller</div>
        </div>
        <div className="tile">
          <div className="label">Of achievable</div>
          <div className="value">{shareOf(rc?.net ?? 0n, ceiling?.net ?? 0n)}</div>
          <div className="note">vs perfect play</div>
        </div>
        <div className="tile">
          <div className="label">Recovered</div>
          <div className="value">
            {rc?.recovered ?? 0}
            <span className="dim" style={{ fontSize: 15 }}>
              /{rc?.recoverable ?? 0}
            </span>
          </div>
          <div className="note">{rate(rc?.rateBps ?? 0)} of recoverable</div>
        </div>
        <div className="tile">
          <div className="label">Spent</div>
          <div className="value">{formatINR(rc?.cost ?? ZERO)}</div>
          <div className="note">fees + messages</div>
        </div>
        <div className="tile">
          <div className="label">Negative-EV attempts</div>
          <div className="value good">{rc?.negativeEvAttempts ?? 0}</div>
          <div className="note">of {rc?.attemptsFired ?? 0} fired</div>
        </div>
      </div>

      <h3>Arms</h3>
      <div className="wrap">
        <table>
          <thead>
            <tr>
              <th>Arm</th>
              <th>Recovered</th>
              <th>Rate</th>
              <th>Value recovered</th>
              <th>Cost</th>
              <th>Net</th>
              <th>Of ceiling</th>
              <th>Neg-EV</th>
            </tr>
          </thead>
          <tbody>
            {arms.map((arm) => (
              <tr key={arm.arm} data-highlight={arm.arm === 'rc' ? 'true' : 'false'}>
                <td>
                  <span className="mono dim">{arm.arm}</span>{' '}
                  <span style={{ fontFamily: 'var(--sans)' }}>{arm.label}</span>
                </td>
                <td>
                  {arm.recovered}/{arm.recoverable}
                </td>
                <td>{rate(arm.rateBps)}</td>
                <td>{formatINR(arm.valueRecovered)}</td>
                <td>{formatINR(arm.cost)}</td>
                <td className={arm.arm === 'rc' ? 'good' : undefined}>{formatINR(arm.net)}</td>
                <td>{shareOf(arm.net, ceiling?.net ?? 0n)}</td>
                <td className={arm.negativeEvAttempts === 0 ? 'good' : 'warn'}>
                  {arm.negativeEvAttempts === 0 && arm.attemptsFired > 0
                    ? '0'
                    : `${arm.negativeEvAttempts}/${arm.attemptsFired}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="callout">
        <strong>
          The controller captured {shareOf(rc?.net ?? 0n, ceiling?.net ?? 0n)} of what perfect
          play could have achieved
        </strong>{' '}
        — {formatINR(sub(rc?.net ?? ZERO, bestBaseline?.net ?? ZERO))} more net value than the
        best baseline ({bestBaseline?.label.toLowerCase()}), while firing{' '}
        {rc?.attemptsFired ?? 0} attempts against its {bestBaseline?.attemptsFired ?? 0}. The
        oracle reads the per-issuer effect no real policy can observe, so its ceiling is
        genuinely unreachable — which is the point of having one. It turns “we beat naive
        retry” into a claim with a scale attached, and it makes the shortfall explicit rather
        than absent.
      </div>

      <h3>By risk class</h3>
      <p className="section-note">
        One engine, five kinds of revenue at risk. The classes differ in exactly three ways —
        which causes are possible, which interventions are legal, and how value and cost are
        computed — and all three are inputs the expected-value gate already took, which is why
        there is one decision path rather than five systems. A single blended net figure cannot
        tell “works across five domains” from “works on payments and loses money on
        receivables”, so it is broken out here.
      </p>
      <div className="wrap">
        <table>
          <thead>
            <tr>
              <th>Risk class</th>
              <th>Txns</th>
              <th>Fired</th>
              <th>Recovered</th>
              <th>Refused</th>
              <th>Value recovered</th>
              <th>Cost</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {byClass.map((row) => (
              <tr key={row.riskClass}>
                <td className="mono">{row.riskClass}</td>
                <td>{row.transactions}</td>
                <td>{row.fired}</td>
                <td className={row.recovered > 0 ? 'good' : 'dim'}>{row.recovered}</td>
                <td className="dim">{row.refused}</td>
                <td>{formatINR(row.valueRecovered)}</td>
                <td>{formatINR(row.cost)}</td>
                <td className={row.net > 0n ? 'good' : 'dim'}>{formatINR(row.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>By failure cause</h3>
      <div className="wrap">
        <table>
          <thead>
            <tr>
              <th>Reason code</th>
              <th>Activity</th>
              <th>Fired</th>
              <th>Recovered</th>
              <th>Refused</th>
              <th>Hit rate</th>
            </tr>
          </thead>
          <tbody>
            {byCode.map((row) => (
              <tr key={row.code}>
                <td className="mono">{row.code}</td>
                <td style={{ width: 130 }}>
                  <div className="bar">
                    <span
                      style={{
                        width: `${((row.fired + row.refused) / maxActivity) * 100}%`,
                      }}
                    />
                  </div>
                </td>
                <td>{row.fired}</td>
                <td className={row.recovered > 0 ? 'good' : 'dim'}>{row.recovered}</td>
                <td className="dim">{row.refused}</td>
                <td>{row.fired === 0 ? '—' : `${((row.recovered / row.fired) * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="callout warn">
        <strong>What these numbers are, before you ask.</strong> Simulated outcomes against a
        probability model the policy engine <em>cannot read</em> — the published priors it
        decides with and the ground truth it is graded against are separately authored tables,
        and the build fails if the policy package can reach the simulator. That makes the
        comparison an inference rather than an identity. It does not make the priors
        themselves correct; <code className="mono">pnpm sweep</code> is what addresses that.
      </div>
    </>
  );
}
