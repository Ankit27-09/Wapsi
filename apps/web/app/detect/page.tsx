import { loadCohorts, loadSignals, loadStreamSize, seedFrom } from '../../lib/queries';
import { SeedPicker } from '../seed-picker';

/**
 * DETECTION — the first of the brief's three verbs.
 *
 * Every other page in this console shows what the agent DID. This one shows what it noticed
 * before it did anything, which is a different kind of evidence: the other pages can be read
 * as a well-tuned rules engine, and this one cannot, because no per-transaction rule can see
 * a cohort going bad.
 *
 * THE UNFLAGGED COHORTS ARE THE MOST IMPORTANT THING HERE. A page listing only detections
 * proves nothing about precision — a detector that alerts on everything would produce the
 * same list plus more. Showing every cohort with its rate, and marking the two that were
 * reported, makes the decision NOT to alert as visible as the decision to alert. There is a
 * cohort on this page sitting at twice the population failure rate that is deliberately not
 * flagged, and that restraint is the harder half of the problem.
 */

const pct = (basisPoints: number): string => `${(basisPoints / 100).toFixed(1)}%`;

const VERDICT_LABEL: Record<string, { label: string; cure: string; tone: string }> = {
  issuer_outage: {
    label: 'Issuer outage',
    cure: 'Re-present elsewhere — a rail switch works',
    tone: 'bad',
  },
  fraud_rule: {
    label: 'Fraud rule',
    cure: 'Stop presenting — the decline travels with the card, not the rail',
    tone: 'warn',
  },
  rail_degraded: {
    label: 'Rail degraded',
    cure: 'Reported only — every alternative shares the problem',
    tone: 'dim',
  },
};

function timeOf(value: Date): string {
  // A fixed locale, deliberately. The simulator runs from a pinned epoch, and formatting in
  // the viewer's locale would render the same run differently on two machines — which is
  // exactly the kind of drift the reproducibility claim exists to rule out.
  return value.toISOString().slice(11, 16);
}

function dayOf(value: Date): string {
  return value.toISOString().slice(5, 10);
}

export default async function DetectPage({
  searchParams,
}: {
  searchParams: Promise<{ seed?: string }>;
}) {
  const seed = seedFrom((await searchParams).seed);
  const [signals, cohorts, stream] = await Promise.all([
    loadSignals(seed),
    loadCohorts(seed),
    loadStreamSize(seed),
  ]);

  const populationBps =
    stream.attempts === 0 ? 0 : Math.round((stream.failures / stream.attempts) * 10_000);

  return (
    <>
      <SeedPicker current={seed} path="/detect" />

      <div className="page-head">
        <h2>Detection</h2>
        <p>
          A rolling 30-minute window over the merchant&rsquo;s whole authorisation stream —
          every attempt, succeeded and failed. A cohort is judged against its PEERS on the
          same rail in the same window, not against a fixed threshold, so an alert means
          &ldquo;this issuer is unusual right now&rdquo; rather than &ldquo;it is evening&rdquo;.
        </p>
      </div>

      {stream.attempts === 0 ? (
        <div className="callout warn">
          <strong>No authorisation stream for seed {seed}.</strong> Detection reads{' '}
          <code className="mono">auth_attempt</code>, which <code className="mono">pnpm demo</code>{' '}
          generates. Run it and refresh.
        </div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="label">Authorisations watched</div>
              <div className="value">{stream.attempts.toLocaleString('en-IN')}</div>
              <div className="note">both outcomes — the failures alone have no denominator</div>
            </div>
            <div className="tile">
              <div className="label">Population failure rate</div>
              <div className="value">{pct(populationBps)}</div>
              <div className="note">what a healthy book looks like here</div>
            </div>
            <div className="tile primary">
              <div className="label">Cohorts reported</div>
              <div className="value">{signals.length}</div>
              <div className="note">of {cohorts.length} watched</div>
            </div>
            <div className="tile">
              <div className="label">Charges refused as a result</div>
              <div className="value good">
                {signals.reduce((total, signal) => total + signal.refusedDecisions, 0)}
              </div>
              <div className="note">fees not paid into a host that was not answering</div>
            </div>
          </div>

          <h3>What was reported</h3>
          <p className="section-note">
            The <span className="mono">lower bound</span> column is why a three-attempt cohort
            cannot raise an alert: it is the bottom of the Wilson interval on the observed
            rate, and it — not the observed rate — has to clear the peer baseline by a margin.
            At small samples that interval is too wide to clear anything.
          </p>

          {signals.length === 0 ? (
            <div className="callout">
              <strong>Nothing was reported for this run.</strong> That is a legitimate result,
              not a missing page — every cohort stayed inside its peers&rsquo; range.
            </div>
          ) : (
            <div className="wrap-scroll">
              <table>
                <thead>
                  <tr>
                    <th>cohort</th>
                    <th>verdict</th>
                    <th>observed</th>
                    <th>peer baseline</th>
                    <th>lower bound</th>
                    <th>n</th>
                    <th>window</th>
                    <th>knew at</th>
                    <th>root cause</th>
                    <th>refused</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((signal) => {
                    const meta = VERDICT_LABEL[signal.verdict];
                    return (
                      <tr key={`${signal.issuerId}${signal.rail}${signal.verdict}`} data-highlight="true">
                        <td>
                          <code className="mono">{signal.issuerId}</code>{' '}
                          <span className="dim">{signal.rail}</span>
                        </td>
                        <td>
                          <span className={`pill ${meta?.tone ?? ''}`}>
                            {meta?.label ?? signal.verdict}
                          </span>
                        </td>
                        <td className="lead-num">{pct(signal.observedBps)}</td>
                        <td className="dim">{pct(signal.baselineBps)}</td>
                        <td>{pct(signal.lowerBoundBps)}</td>
                        <td>{signal.attempts}</td>
                        <td className="mono nowrap">
                          {dayOf(signal.windowStart)} {timeOf(signal.windowStart)}–
                          {timeOf(signal.windowEnd)}
                        </td>
                        <td className="mono">{timeOf(signal.firstSeenAt)}</td>
                        <td>
                          <code className="mono">{signal.dominantCode ?? '—'}</code>
                        </td>
                        <td>{signal.refusedDecisions}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="callout">
            <strong>The verdict decides the cure, and they are opposites.</strong>{' '}
            {signals.map((signal) => (
              <span key={signal.verdict} className="cure-line">
                <code className="mono">{signal.verdict}</code> →{' '}
                {VERDICT_LABEL[signal.verdict]?.cure ?? '—'}
              </span>
            ))}{' '}
            Getting that backwards means switching rails to evade a risk engine, which is
            futile and, repeated at volume, is how a merchant loses its acquirer.
          </div>

          <h3>Every cohort, including the ones left alone</h3>
          <p className="section-note">
            Restraint is the harder half. A detector that alerted on everything would produce
            the table above plus more rows, and would look identical on a page that showed
            only its alerts — so this shows all of them.
          </p>

          <div className="wrap-scroll">
            <table>
              <thead>
                <tr>
                  <th>issuer</th>
                  <th>rail</th>
                  <th>authorisations</th>
                  <th>failures</th>
                  <th>failure rate</th>
                  <th>vs population</th>
                  <th>reported?</th>
                </tr>
              </thead>
              <tbody>
                {cohorts.map((cohort) => {
                  const ratio = populationBps === 0 ? 0 : cohort.failureBps / populationBps;
                  return (
                    <tr
                      key={`${cohort.issuerId}${cohort.rail}`}
                      {...(cohort.flagged ? { 'data-highlight': 'true' } : {})}
                    >
                      <td>
                        <code className="mono">{cohort.issuerId}</code>
                      </td>
                      <td className="dim">{cohort.rail}</td>
                      <td>{cohort.attempts.toLocaleString('en-IN')}</td>
                      <td>{cohort.failures.toLocaleString('en-IN')}</td>
                      <td className="lead-num">{pct(cohort.failureBps)}</td>
                      <td className="dim">{ratio.toFixed(2)}×</td>
                      <td>
                        {cohort.flagged ? (
                          <span className="pill bad">reported</span>
                        ) : (
                          <span className="dim">
                            {ratio > 1.5 ? 'elevated, immaterial' : 'within peers'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="callout">
            <strong>Two independent guards, for two different reasons.</strong> The Wilson
            lower bound is <em>statistical</em> — three failures out of three cannot clear a
            9% baseline, three hundred out of four hundred can. A minimum sample count is{' '}
            <em>operational</em>, and it is not redundant: eight consecutive failures is
            overwhelming evidence (p ≈ 4×10⁻⁹) and still usually not worth moving anyone off
            an issuer, because twenty cohorts watched continuously throw runs like that
            constantly. Significance and materiality are different questions.
          </div>
        </>
      )}
    </>
  );
}
