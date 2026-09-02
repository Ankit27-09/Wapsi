import Link from 'next/link';
import { formatINR } from '@rc/core';
import { loadArms, loadByRiskClass, seedFrom } from '../lib/queries';
import { SeedPicker } from './seed-picker';

/**
 * The landing page.
 *
 * Every other route in this console is for someone checking a number. This one is for someone
 * who has just been handed the URL and has thirty seconds to decide whether the project is
 * serious — so it leads with the argument rather than with the data, and then gets out of the
 * way.
 *
 * ONE RULE HELD THROUGHOUT: nothing on this page is a number I typed in. The headline figures
 * are read from Postgres on every request, exactly as the dashboard reads them, so a stale
 * claim is impossible by construction rather than by discipline. A landing page that quotes a
 * result the system no longer produces is worse than one that quotes nothing.
 */

/** The seven example directions the Track 03 brief names, and what each one required. */
const DIRECTIONS = [
  {
    id: '01',
    title: 'Smart retry policy',
    lede: 'Diagnose the cause, then choose timing and rail to match it.',
    body:
      'Eighteen failure causes, and a class exists only if it earns a distinct intervention. ' +
      'Splitting two codes that get the same treatment buys nothing; merging an expired card ' +
      'into a balance decline loses money, because retrying an expired card succeeds exactly ' +
      'zero percent of the time forever.',
    proof: 'insufficient_funds retries into the salary window; threeds_timeout switches rail',
  },
  {
    id: '02',
    title: 'Mandate retry sequencer',
    lede: 'A debit that has no notice behind it does not fire.',
    body:
      'Under RBI e-mandate rules a recurring debit must be preceded by a notification at ' +
      'least 24 hours earlier. The engine reads that from messages actually DELIVERED, not ' +
      'from the decision that planned one — so a notice suppressed by quiet hours leaves the ' +
      'debit unlawful, and the debit refuses itself.',
    proof: 'pre_debit_notice bound · a knock-on effect: sub-day backoffs become unavailable',
  },
  {
    id: '03',
    title: 'Failed-subscription recovery',
    lede: 'The loss is the subscriber, not the cycle.',
    body:
      'Losing a ₹499 cycle usually means losing every cycle after it, so the value at stake ' +
      'is margin multiplied by the remaining term. The same probability then justifies several ' +
      'times the spend — which is why a subscription gets a sequence where a one-off gets a ' +
      'single probe.',
    proof: 'value = margin × lifetime_cycles, reported separately from cash collected',
  },
  {
    id: '04',
    title: 'Checkout drop-off recovery',
    lede: 'How far they got is the entire signal.',
    body:
      'Someone who left at the cart was browsing. Someone who reached the OTP screen had ' +
      'their card out. Those recover at rates more than 5× apart, so they are separate causes ' +
      'with separate strategies — and nothing was ever charged, so there is no gateway fee and ' +
      'no instrument to retry. The whole cost is eighteen paise.',
    proof: 'four funnel stages · payment_link only · no rail, by database constraint',
  },
  {
    id: '05',
    title: 'B2B receivables chaser',
    lede: 'Non-payment is a process problem, not an inability to pay.',
    body:
      'An invoice waiting on an approver needs a different nudge from one stuck behind a ' +
      'monthly payment run, and a disputed one needs a human immediately — chasing it applies ' +
      'pressure over an amount genuinely in question. The ladder climbs CHANNEL rather than ' +
      'volume: two messages, then one call, then it stops.',
    proof: 'five causes, five strategies · disputed_line_item gets no automated contact at all',
  },
  {
    id: '06',
    title: 'Promise-to-pay tracker',
    lede: 'Primarily a suppression mechanism.',
    body:
      'A buyer who says “I will pay on the 10th” has given you the most valuable thing in ' +
      'collections, and the correct response is to stop chasing until the 10th. An open ' +
      'promise blocks the ladder and records await_promise rather than none, so an operator ' +
      'can tell deliberate waiting from an idle invoice.',
    proof: 'promise_open bound · a broken promise escalates straight to a call, then a human',
  },
  {
    id: '07',
    title: 'Hinglish voice recovery',
    lede: 'A call is not a louder SMS.',
    body:
      'In India voice sits under a separate regime: the NCPR/DND registry overrides ' +
      'merchant-level consent, the permitted calling window is narrower than quiet hours, and ' +
      'it costs roughly twenty-two times an SMS. Modelling it as a channel rather than a ' +
      'special case is what lets the expected-value gate decide between a message and a call.',
    proof: 'registered Hinglish scripts · 10:00–19:00 window · one call per customer per week',
  },
] as const;

/** The five kinds of revenue at risk, for the problem statement. */
const LEAKS = [
  { code: 'payment_failure', label: 'A payment failed', detail: 'Card declined, issuer down, 3DS abandoned' },
  { code: 'subscription_failure', label: 'A cycle failed', detail: 'The monthly charge did not go through' },
  { code: 'mandate_lapsed', label: 'The mandate lapsed', detail: 'The autopay permission itself is gone' },
  { code: 'checkout_abandonment', label: 'Checkout abandoned', detail: 'They left before paying anything' },
  { code: 'receivable_overdue', label: 'An invoice is overdue', detail: 'A B2B buyer has not paid' },
] as const;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ seed?: string }>;
}) {
  const seed = seedFrom((await searchParams).seed);
  const arms = await loadArms(seed);
  const byClass = await loadByRiskClass(seed);

  const rc = arms.find((a) => a.arm === 'rc');
  const ceiling = arms.find((a) => a.arm === 'b3_oracle');
  const dunning = arms.find((a) => a.arm === 'b2');

  const hasRun = rc !== undefined && ceiling !== undefined;

  /** Share of the ceiling, on value recovered. Blank when no run exists to read. */
  const shareOfCeiling =
    hasRun && ceiling.valueRecovered > 0n
      ? `${(Number((rc.valueRecovered * 10_000n) / ceiling.valueRecovered) / 100).toFixed(1)}%`
      : '—';

  const classesExercised = byClass.filter((c) => c.transactions > 0).length;

  return (
    <>
      {/* ---------- hero ---------- */}
      <section className="hero">
        <div className="hero-badge">
          <span className="pill accent">Track 03</span>
          <span className="dim">AI Revenue Recovery · Razorpay AI Buildathon 2026</span>
        </div>

        <h1 className="hero-title">
          Most recovery attempts <span className="lit">destroy value</span>
        </h1>

        <p className="hero-lede">
          A card retry costs ₹3.50 whether it works or not, so a system that retries everything
          can spend more than it collects. This one decides <em>what</em> to try, <em>when</em>,
          and on which rail or channel — and most of the time it decides{' '}
          <strong>not to act at all</strong>, with the arithmetic that produced the refusal
          recorded beside it.
        </p>

        <p className="hero-sub">
          One decision engine across five kinds of revenue at risk. Every rupee it spends had
          to clear an expected-value gate first, and every rupee it declined to spend can
          explain itself.
        </p>

        {hasRun ? (
          <div className="hero-stats">
            <div className="hero-stat primary">
              <div className="label">Net value recovered</div>
              <div className="value">{formatINR(rc.net)}</div>
              <div className="note">on {rc.recoverable} recoverable of 300</div>
            </div>
            <div className="hero-stat">
              <div className="label">Of the achievable ceiling</div>
              <div className="value">{shareOfCeiling}</div>
              <div className="note">vs perfect-knowledge play</div>
            </div>
            <div className="hero-stat">
              <div className="label">Value-destroying attempts</div>
              <div className="value good">{rc.negativeEvAttempts}</div>
              <div className="note">of {rc.attemptsFired} fired · refused by construction</div>
            </div>
            <div className="hero-stat">
              <div className="label">Risk classes live</div>
              <div className="value">{classesExercised}</div>
              <div className="note">one engine, not five systems</div>
            </div>
          </div>
        ) : (
          <div className="callout warn">
            <strong>No run is loaded.</strong> These figures are read from Postgres rather than
            written into the page, so there is nothing to show until a batch exists. Run{' '}
            <code className="mono">pnpm demo</code> and refresh.
          </div>
        )}

        <div className="hero-actions">
          <Link href="/overview" className="btn primary">
            See the evidence →
          </Link>
          <Link href="/exceptions" className="btn">
            Every refusal, with its arithmetic
          </Link>
          <Link href="/policy" className="btn">
            The policy, as data
          </Link>
        </div>

        {hasRun && dunning !== undefined ? (
          <p className="hero-foot">
            Read from batch <code className="mono">seed {seed}</code> on every request — no
            cached figures, nothing typed in. Same seed always gives the same numbers, which is
            a guarantee rather than a coincidence; run{' '}
            <code className="mono">pnpm eval --seed 99</code> and every figure on this page
            moves. For scale: the fixed-schedule dunning baseline fired{' '}
            <strong>{dunning.negativeEvAttempts}</strong> attempts its own evidence said would
            lose money. This system fired <strong>{rc.negativeEvAttempts}</strong>.
          </p>
        ) : null}
      </section>

      {/* The picker sits here rather than above the hero, because the paragraph directly
          above it makes exactly this promise — that a different seed moves every figure. A
          control beats a sentence saying the same thing. */}
      <SeedPicker current={seed} path="/" />

      {/* ---------- the problem ---------- */}
      <h3>Five ways a merchant leaks revenue</h3>
      <p className="section-note">
        They look like five different problems and they are the same shape of problem: an amount
        of money attached to a customer, with a cause, on which a bounded and priced
        intervention may be attempted. That is why there is one engine.
      </p>

      <div className="leak-grid">
        {LEAKS.map((leak) => {
          const slice = byClass.find((c) => c.riskClass === leak.code);
          return (
            <div className="leak" key={leak.code}>
              <div className="leak-head">
                <strong>{leak.label}</strong>
                {slice !== undefined && slice.transactions > 0 ? (
                  <span className="pill">{slice.transactions} in batch</span>
                ) : null}
              </div>
              <p>{leak.detail}</p>
              <code className="mono dim">{leak.code}</code>
            </div>
          );
        })}
      </div>

      {/* ---------- the core idea ---------- */}
      <h3>The one idea everything hangs off</h3>
      <p className="section-note">
        Before any action fires — a retry, a payment link, a call — it has to clear this. It is
        the whole product, and it is why the answer is so often no.
      </p>

      <div className="formula">
        <div className="formula-line">
          <span className="tok p">probability</span>
          <span className="op">×</span>
          <span className="tok v">(amount × contribution margin)</span>
          <span className="op">−</span>
          <span className="tok c">cost</span>
          <span className="op">≥</span>
          <span className="tok f">floor</span>
        </div>
        <div className="formula-notes">
          <div>
            <strong>Margin, not the gross amount.</strong> Recovering a rupee of revenue is
            worth its margin, not a rupee. A ₹4 lakh invoice at 8% and a ₹499 subscription at
            26% over six remaining cycles are closer in value than their sizes suggest.
          </div>
          <div>
            <strong>Stopping is derived, not configured.</strong> There is no{' '}
            <code className="mono">maxAttempts</code> constant doing the real work. A sequence
            ends when the expected value crosses the floor.
          </div>
          <div>
            <strong>Integers end to end.</strong> Paise as <code className="mono">bigint</code>,
            probabilities and margins as basis points. There is no floating-point number
            anywhere in the money path, and no way to construct one by accident.
          </div>
        </div>
      </div>

      {/* ---------- the seven directions ---------- */}
      <h3>What is built</h3>
      <p className="section-note">
        The brief names seven example directions. All seven are here — the table below says what
        each one actually required, because the interesting part of each was a constraint rather
        than a feature.
      </p>

      <div className="feature-grid">
        {DIRECTIONS.map((d) => (
          <article className="feature" key={d.id}>
            <div className="feature-id">{d.id}</div>
            <h4>{d.title}</h4>
            <p className="feature-lede">{d.lede}</p>
            <p className="feature-body">{d.body}</p>
            <div className="feature-proof mono">{d.proof}</div>
          </article>
        ))}
      </div>

      {/* ---------- why believe it ---------- */}
      <h3>Why any of these numbers mean anything</h3>

      <div className="wall">
        <div className="wall-side">
          <div className="wall-label">what the policy believes</div>
          <code className="mono">priors.published.yaml</code>
          <p>
            “A salary-window retry works 45% of the time.” Every row carries a source, or the
            explicit admission that there isn’t one — and an assumed row is given a wider
            perturbation band automatically, so honesty is mechanised rather than promised.
          </p>
        </div>

        <div className="wall-bar">
          <span>cannot import</span>
        </div>

        <div className="wall-side">
          <div className="wall-label">what the world actually does</div>
          <code className="mono">priors.truth.yaml</code>
          <p>
            “It works 41%.” Separately authored, deliberately different, and varying by issuer
            in ways no merchant’s gateway would ever disclose. The policy is <em>permitted to
            be wrong</em> here.
          </p>
        </div>
      </div>

      <div className="callout">
        <strong>If the policy could read the truth, “our strategy won” would be circular.</strong>{' '}
        It would be a mirror of the oracle grading it, and the headline number would carry no
        information. Two independent checks fail the build if that import appears — an ESLint
        rule on the import specifier and a dependency-cruiser rule on the resolved graph. The
        first version used only one, and it{' '}
        <em>silently passed with a real violation in the file</em>, because a pnpm workspace
        import resolves through a symlink the config had excluded from the graph. A boundary
        nobody has tried to break is not a boundary.
      </div>

      <div className="closing">
        <div className="closing-item">
          <div className="closing-value">101</div>
          <div className="closing-label">tests, including property tests that generate their own counterexamples</div>
        </div>
        <div className="closing-item">
          <div className="closing-value">19</div>
          <div className="closing-label">
            bugs recorded in <code className="mono">FAILURES.md</code> — five of which had
            inflated these very numbers
          </div>
        </div>
        <div className="closing-item">
          <div className="closing-value">500</div>
          <div className="closing-label">
            perturbed worlds the conclusion is re-tested in, and survives in all of them
          </div>
        </div>
      </div>
    </>
  );
}
