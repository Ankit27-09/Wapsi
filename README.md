# Recovery Controller

**Expected-value gated revenue recovery with a bounded, self-improving policy.**
Razorpay AI Buildathon 2026 · Track 03 — AI Revenue Recovery

One decision engine across five kinds of revenue at risk: failed payments, failed
subscription cycles, lapsed mandates, abandoned checkouts and overdue B2B invoices. It decides
what to try, when, on which rail or channel — and, most of the time, **decides not to act at
all**, because most recovery attempts destroy value and the system can prove which ones.

---

## Results

<!-- Regenerate with `pnpm demo`. Seed 42, policy v1. -->

300 transactions · 293 recoverable · every arm on an identical seeded population

| Arm | Recovered | Rate | ₹ value recovered | ₹ cost | ₹ **net** | **% of ceiling** |
|---|---|---|---|---|---|---|
| **B0** · do nothing | 0/293 | 0.0% | ₹0.00 | ₹0.00 | ₹0.00 | 0.0% |
| **B1** · retry all, immediately | 25/293 | 8.5% | ₹54,979.68 | ₹429.00 | ₹54,550.68 | 11.5% |
| **B2** · fixed-schedule dunning | 50/293 | 17.1% | ₹96,995.05 | ₹1,118.60 | ₹95,876.45 | 20.4% |
| **B4** · blast reminders at everything | 9/293 | 3.1% | ₹99,401.01 | ₹127.00 | ₹99,274.01 | 20.9% |
| **B3** · oracle (ceiling) | 117/293 | 39.9% | ₹4,76,316.79 | ₹576.14 | ₹4,75,740.65 | **100.0%** |
| **RC** · Recovery Controller | **76/293** | **25.9%** | **₹2,97,863.79** | **₹357.82** | **₹2,97,505.97** | **62.5%** |

**Negative expected-value attempts**, priced against the *published* priors — the evidence
available beforehand, not hindsight:

| Arm | Wasted attempts | ₹ spent on them |
|---|---|---|
| B1 | 97 of 171 | ₹260.00 |
| B2 | **345 of 435** | ₹923.80 |
| B4 | **518 of 557** | ₹100.88 |
| RC | **0 of 290** | ₹0.00 — the gate refuses them by construction |

**% of ceiling is value recovered against the oracle's, not net against net.** The oracle
assumes every customer is reachable, so it sends messages the controller's consent bounds
suppress — and pays for them. On a class where both recover the same transactions, that extra
postage made net-against-net exceed 100%, which is impossible for a ceiling and was the
symptom of a real definitional problem. Cost stays in the table beside it, where a difference
in spending is visible rather than baked into the headline ratio.

### One engine, five kinds of revenue at risk

A single blended figure cannot tell "works across five domains" from "works on payments and
loses money on receivables", and the aggregate is exactly where a per-class failure would
hide. So it is broken out, against the oracle's ceiling **for that class**:

| Risk class | Txns | Fired | Recovered | Refused | ₹ net | ₹ ceiling | % of ceiling |
|---|---|---|---|---|---|---|---|
| `payment_failure` | 108 | 137 | 44/104 | 64 | ₹1,98,530 | ₹2,08,808 | **95.2%** |
| `subscription_failure` | 63 | 69 | 20/63 | 43 | ₹15,555 | ₹23,175 | **67.5%** |
| `checkout_abandonment` | 62 | 42 | 4/62 | 58 | ₹6,942 | ₹8,705 | **79.8%** |
| `receivable_overdue` | 44 | 20 | 6/41 | 38 | ₹76,078 | ₹2,34,064 | **32.5%** |
| `mandate_lapsed` | 23 | 22 | 2/23 | 21 | ₹401 | ₹1,565 | **25.9%** |

Plus **₹1,53,858 of subscription value preserved** beyond the recovered cycle — reported
separately and never folded into net. Net is margin on money that has moved; that figure is
margin on cycles a saved subscription will pay *if* it runs its expected term. It is the basis
the expected-value gate priced on, which is why it is shown at all, but it rests on an
assumption and the headline should not.

### Why receivables sits at 32.5% — the price of the guardrails

The obvious question about the table above is why the two messaging-only classes trail. The
answer is a number, not a paragraph:

| Rule | Refusals | ₹ expected recovery forgone | Share |
|---|---|---|---|
| `consent` | 86 | ₹1,70,547 | **88.3%** |
| `contact_ceiling` | 17 | ₹21,707 | 11.2% |
| `never_contact` | 3 | ₹759 | 0.4% |
| `ev_floor` | 9 | ₹49 | 0.0% |
| `min_gap` | 1 | ₹49 | 0.0% |
| `promise_open` | 1 | ₹17 | 0.0% |
| `attempt_cap` / `terminal` | 107 | ₹0 | 0.0% |

**₹1,93,127 across 224 refusals, and 88% of it is consent.** Forty percent of the seeded
customer book has either opted out or never opted in. Checkout abandonment and overdue
receivables recover money by messaging and nothing else — there is no charge to re-present —
so a customer who cannot be messaged cannot be recovered, and the oracle is permitted to
message them while the controller is not.

That is the price of the compliance envelope, not a list of bugs. `attempt_cap` and `terminal`
forgo exactly ₹0, which is the gate working: those refusals decline actions whose expected
recovery was already zero. `ev_floor` is the one line here a merchant is actually free to move.

### B2 is the comparison that matters

B1 takes one attempt where RC takes up to three, so its gap could be dismissed as volume.
**B2 removes that objection**: same fixed cadence, same three-attempt budget, no diagnosis.
Whatever separates them is the value of *knowing why the payment failed*.

| | Attempts fired | Recovered | Per-attempt hit rate | ₹ spent | ₹ net |
|---|---|---|---|---|---|
| **B2** | 435 | 50 | 11.5% | ₹1,118.60 | ₹95,876 |
| **RC** | **290** | **76** | **26.2%** | **₹357.82** | **₹2,97,506** |

**RC recovered 52% more transactions while firing 33% fewer attempts and spending 68%
less** — 2.3× the per-attempt hit rate, and 3.1× the net value. That is targeting isolated
from persistence.

B2 also fired **345 of its 435 attempts at negative expected value**, because a fixed cadence
re-presents expired cards and revoked mandates with the same enthusiasm as a transient
timeout. It is not a strawman — it is what dunning tools actually ship.

### B4 is the comparison for everything that cannot be retried

B1 and B2 are retry baselines, and two of the five risk classes have nothing to retry. Without
an **untargeted messaging** baseline, the controller's results on checkout abandonment and
overdue receivables would only be measurable against doing nothing — a much easier bar than
the one the payment classes are held to, and a gap a careful reader would notice.

B4 does what an off-the-shelf abandoned-cart or dunning tool does: three generic reminders per
transaction on a fixed cadence, no diagnosis, no expected-value gate, no contact ceiling. It
respects template registration, because that is a legal constraint rather than a policy
preference and a baseline that broke it would not correspond to anything anyone could run.

It fired **557 messages to recover 9 transactions** — 518 of those attempts at negative
expected value. The controller sent fewer messages and recovered eight times as much value,
which is the difference between knowing that an OTP drop-off is worth chasing within minutes
and a browsing cart may not be worth chasing at all.

### The gap to the ceiling is stated, not hidden

The oracle reads the per-issuer effect no real policy can observe, evaluates every timing and
every intervention available, and plays optimally against the true outcome distribution. It is
a **measurement ceiling, not a strategy** — nothing that reads the outcome before choosing the
action can ship.

It is also bounded by law rather than by preference, which took three attempts to get right
(entries 5a–5c in [`FAILURES.md`](FAILURES.md)). It ignores the expected-value floor, the
attempt cap and the contact ceiling, because those are a merchant's choices. It does **not**
ignore the pre-debit notification requirement, because that is the condition under which an
e-mandate debit is lawful at all — an oracle that debits without notice is not a ceiling but a
fantasy, and reporting the controller as a fraction of one understates it against something
nobody is permitted to do.

---

## Scope — every direction in the brief

Track 03 lists seven example directions. All seven are built, and this table says where each
one lives so a reader can check rather than take the claim on trust.

| Brief direction | Mechanism | Where |
|---|---|---|
| **Smart retry policy** — root-cause diagnosis, per-cause timing and rail | 18-code taxonomy where a class exists only if it earns a distinct intervention; timing buckets carry the priors; `switch_rail` for authentication failures | [`taxonomy.ts`](packages/core/src/taxonomy.ts), [`policy.default.yaml`](packages/policy/policy.default.yaml) |
| **Mandate retry sequencer** — sequenced retries in the permitted window, with pre-debit notification | A charge on a mandate rail is **refused** unless a notification was *delivered* ≥24h earlier. Read from `message_send`, not from the decision that planned it — a notice suppressed by quiet hours never reached the customer, so the debit is still unlawful | `pre_debit_notice` bound in [`bounds.ts`](packages/policy/src/bounds.ts) |
| **Failed-subscription recovery** — value is the relationship, not the cycle | Value term multiplies by `lifetime_cycles`, so the same probability justifies several times the spend. Reported separately from cash, never added to it | `valueCycles` in [`ev.ts`](packages/policy/src/ev.ts) |
| **Checkout drop-off recovery** — messaging only, no gateway fee | Four separate causes by funnel stage, because their recovery rates differ by more than 5×. Nothing was charged, so no fee applies — the whole cost is 18 paise, which is why a link clears the floor where a ₹3.50 retry cannot | `checkout_abandonment` class, `incursGatewayFee` in [`risk.ts`](packages/core/src/risk.ts) |
| **B2B receivables chaser** — escalation ladder, payment-run timing, hard stop | Five causes with five strategies. The ladder climbs **channel** rather than volume — two messages, then one call — and stops. A disputed invoice gets a human immediately and no automated contact at all | `receivable_overdue` class |
| **Promise-to-pay tracker** — a suppression mechanism first | An open promise **blocks** the ladder until its date and records `await_promise` rather than `none`, so the audit trail distinguishes deliberate waiting from an idle invoice. A broken promise changes the action, not just the odds: straight to a call, then a human | `promise` table, `promise_open` bound |
| **Hinglish voice recovery** — voice as a channel, not a louder SMS | Registered voice scripts (Hinglish variants selected by `preferred_language`), NCPR/DND registry override, a narrower 10:00–19:00 calling window, one call per week, and ~22× the cost of an SMS — so the expected-value gate decides between a message and a call | `voice` channel, [`templates.ts`](packages/simulator/src/templates.ts) |

**What the generalisation actually cost.** Five classes, one engine — not five systems. The
classes differ in exactly three ways, and all three were already inputs the expected-value gate
took: which causes are possible, which interventions are legal, and how value and cost are
computed. So there is one decision path, one audit trail, one set of bounds and one evaluation
harness. The differences are data:

```
RISK_CLASS_META[riskClass] → { causes, interventions, recurring }
```

Two invariants make that safe rather than merely tidy. A policy that schedules an intervention
a class does not permit **fails to load** — including a base entry inherited by a class that
would not permit it. And a retry on a lapsed mandate is refused as `illegal_intervention`
*before* it is priced, because reporting it as `refuse_ev` would suggest a better-priced
version of the same action might work, which is exactly the wrong conclusion.

### The bounded improvement loop — `pnpm propose`

After a batch, the agent reads the audit trail and proposes changes to the policy. A human
approves each one. Approved changes are evaluated on a **held-out seed**.

**The safety property is the schema, not the prompt.** The agent cannot propose relaxing the
kill switch, widening quiet hours, raising the contact ceiling, weakening consent, or
enlarging the fee budget — not because it is told not to, but because **there is no field in
which to say it**. `TUNABLE_FIELDS` is the complete vocabulary of the proposal type; a model
emitting `{"field": "kill_switch"}` fails enum validation before any human sees it. A prompt
saying "never touch the safety bounds" is a request; a schema without those fields is a
guarantee, and it holds under prompt injection, model error, and a contributor who did not
read the comment.

What it actually proposed, unedited:

> *"Evidence for gap tuning is thin because nothing in this batch was refused for min_gap:
> the 199 refusals are dominated by attempt_cap (129) and terminal reason codes (64), which
> are outside what I can change. […] I explicitly recommend no change to
> insufficient_funds min_gap_hours: 48h into the salary window is the single
> best-performing cohort in the batch (₹1,05,453.76 recovered on ₹153.50 of fees) and
> should not be disturbed."* — confidence 52%, cost ₹8.92

It noticed its own evidence was thin, recommended *against* touching the best-performing
cohort, and gave a calibrated 52% rather than a reflexive 0.9.

**Then the held-out evaluation earned its place, twice.**

```
Approving:
  [1] threeds_timeout.min_gap_hours: 0 → 24   (confidence 55%)

  Held-out evaluation (seed 99)
    v1 (current)                 ₹3,76,041.88  338 fired, 106 recovered
    v2 (approved)                ₹3,64,106.67  322 fired, 103 recovered

  Measured delta on unseen data: -₹11,935.21 against a predicted ₹2,066.67.
```

**The agent predicted +₹2,067. Unseen data said −₹11,935.** A plausible change, cited
evidence, a calibrated 55%, approved by a human — and it would have destroyed value. The
policy file was never rewritten; approval records a decision, not a deployment.

An earlier proposal failed differently and just as usefully:
`do_not_honour.min_gap_hours: 24 → 48` measured **exactly zero**, because that code permits a
single attempt and `min_gap_hours` only binds from the second onward. Legal, in range,
well-argued, and completely inert. (The agent is now only offered codes whose schedule
permits a second attempt — a fix the held-out run paid for.)

That is the case for the loop in one screen: **the agent proposes, a person decides, and the
held-out run is what stops a plausible change from being believed.** A self-improving system
that could not produce this output would be a self-*changing* one.

Proposals are stored before review and decided by stable id — `--approve 3`, `--reject 4
--note "why"` — because the agent is not deterministic and regenerating at approval time
would approve something nobody read. Rejections are recorded with an author and a reason;
a decided proposal cannot be decided twice.

### Sensitivity — `pnpm sweep`

Every ground-truth probability perturbed independently by up to **±60%**, 500 times. The
truth table carries no citations, so it gets the widest band — and it is the truth that is
perturbed, not the published priors, because the question a panel is really asking is
*"does this survive the world not being what you invented?"*

| | Controller net value |
|---|---|
| worst of 500 worlds | ₹1,38,241.93 |
| median | ₹3,34,291.58 |
| best | ₹4,86,595.01 |

**The controller beat the best baseline in 500 of 500 worlds.** 600,000 transaction-runs in
7.8 seconds, because the sweep replays the real policy engine in memory — same `planNext`,
same expected-value gate, same bounds, no persistence.

> **500/500 is a weaker result than it looks, and I say so on the slide.** Perturbing each
> prior independently means the noise largely averages out across 300 transactions. The
> sharper test is a world where one assumption is *systematically* wrong — see the hostile
> worlds below.

**The sweep is verified to be the same system, not a lookalike.** Its outcome draws are
keyed on each attempt's own idempotency key, derived identically to the real gateway's, so
an in-memory replay of the shipped world reproduces the persisted run **exactly**: same 322
attempts fired, same 116 recovered. A test asserts that parity, and asserts the net-value
gap equals the messaging cost the sweep excludes — so an unexplained divergence fails the
build rather than passing as "close enough".

### Hostile worlds

One assumption systematically false. **The success criterion is not that the controller
still wins** — that would be a claim about luck. It is that the expected-value gate notices
attempts are not paying and *stops*, bounding the downside near do-nothing.

| World | The assumption it falsifies | ₹ net | Fired | Recovered | Downside |
|---|---|---|---|---|---|
| *(shipped)* | — | ₹3,65,509.12 | 322 | 116 | — |
| **H1** Flat salary window | Retrying after a salary credit beats retrying immediately | ₹2,67,156.93 | 322 | 91 | **bounded** |
| **H2** Long issuer outages | Issuer incidents clear within an hour | ₹3,13,079.41 | 368 | 92 | **bounded** |
| **H3** Dirty labels (30% mislabelled) | The classifier identifies the cause correctly | ₹2,11,327.21 | 378 | 92 | **bounded** |

Read the **Fired** column — it is where the mechanism shows. Under H1 the controller fires
*exactly as many* attempts and simply recovers less: its premise is wrong and it does not
compensate by trying harder. Under H2 and H3 it fires more, because a mistuned backoff and
a wrong label both send transactions down longer schedules — and even then the gate holds
the loss to a haircut rather than a rout.

**Worst case is a 42% reduction, still 1.8× the best baseline, and never negative.** H3 is
deliberately punishing: 30% mislabelling is ten times worse than the keyword baseline's
measured 3% and thirty times worse than the model's 1%.

**Threshold on the load-bearing assumption.** Walking the salary-window lift from 0.2× to
4.0× of the immediate-retry probability, with common random numbers so only the parameter
moves: the controller's net value rises monotonically from ₹2,56,178 to ₹3,51,969 — the
assumption is worth about ₹96,000 — but **no crossover exists in that range.** It still wins
where the salary window is five times *worse* than an immediate retry, because most of its
advantage comes from refusing attempts that cannot pay for themselves rather than from
timing the ones that can. The boundary lies outside the tested range, wherever it is.

### Classifier ablation — `pnpm ablate`

**Accuracy**, on 60 hand-labelled gateway strings across three difficulty tiers:

| Arm | Accuracy | Macro-F1 | easy | hard | opaque | Quarantined |
|---|---|---|---|---|---|---|
| **keyword** | 61.7% | 69.1% | 100.0% | 82.1% | **0.0%** | 23/60 |
| **llm** (`claude-opus-5`) | 65.0% | 70.0% | 100.0% | **89.3%** | **0.0%** | 21/60 |

The accuracy gain is small overall (+3.3 points) and concentrated exactly where you would
predict — **the hard tier, 82.1% → 89.3%**: bare ISO response codes, vendor mnemonics,
transliterated Hinglish. Both arms sit at 0% on the opaque tier, and for both that is
correct behaviour. On this evidence alone the model would be hard to justify. The rupee
table below is where the case actually gets made, which is the entire argument for
measuring a classifier in currency.

**And what it costs** — identical policy, identical seeded population, classifier swapped:

| Arm | Recovered | Rate | Quarantined | Mislabelled | Model cost | ₹ **net** | **% of ceiling** |
|---|---|---|---|---|---|---|---|
| **oracle** (ceiling) | 101/236 | 42.8% | 0 | 0 | ₹0.00 | ₹3,47,721.09 | **100.0%** |
| **keyword** | 55/236 | 23.3% | 142 | 10 | ₹0.00 | ₹1,36,721.28 | **39.3%** |
| **llm** (`claude-opus-5`) | 58/236 | 24.6% | 135 | **3** | ₹68.64 | **₹1,95,208.02** | **56.1%** |

> **The model earns ₹852 for every ₹1 it costs.** ₹58,486.74 more net value than the
> keyword baseline, for ₹68.64 of spend — ₹0.23 per classification.

The mechanism is the mislabel column: **3 wrong labels against 10.** A mislabel does not
just miss a recovery, it spends a fee executing the *wrong* schedule correctly — retrying a
revoked mandate, re-presenting an expired card.

**Classification error is the single largest loss in the system.** The keyword arm forfeits
60.7% of what perfect labelling would have achieved; the model recovers about a quarter of
that gap and leaves ₹1,52,513 on the table. That remaining amount is larger than everything
the model has captured, and it is mostly the 135 quarantines — the opaque tier and the novel
strings. It is the budget for the open-world clustering path.

> **This comparison was not controlled until migration 011.** Each arm ran in its own world
> so they could not contaminate one another's contact ceilings — but transaction ids encode
> the world, the idempotency key hashes the id, and the simulator seeded outcomes from that
> key. So **the three arms faced three different sets of coin flips**, and the measured gap
> was five recoveries out of sixty — comfortably inside the noise that produces. Outcomes
> now key on a world-independent `logical_ref`, so every arm meets the same successes and
> failures. The controlled gap is *larger* (₹58,487 against ₹39,065), and it is now signal.

### Calibration — does the classifier know when it is right?

Confidence decides whether the system **acts or quarantines**, so a number that says 0.9 and
is right 60% of the time spends money on a cause nobody identified.

| Arm | ECE | Direction |
|---|---|---|
| **keyword** | 9.4% | under-confident by 9.4% |
| **llm** | **27.7%** | **OVERCONFIDENT by 14.7%** |

**The model is most wrong exactly where it is most certain.** Its 90–100% bin holds half the
corpus, states 92.6% confidence, and is right **76.7%** of the time. Its 60–75% bin is right
100%. The keyword table has the opposite and safer failure mode: **whenever it commits at
all, it is right 100% of the time** — every one of its errors is a quarantine, never a wrong
answer.

| Act above | Coverage | Accuracy of what we act on | Acted **and wrong** |
|---|---|---|---|
| 0% | 100.0% | 65.0% | 21 |
| 40% | 93.3% | 69.6% | 17 |
| **60%** | **78.3%** | **83.0%** | **8** |
| 75% | 65.0% | 79.5% | 8 |
| 90% | 50.0% | 76.7% | 7 |

**0.6 is the operating point, and the curve is why.** Raising the threshold to 0.75 or 0.9
makes accuracy *worse* while cutting coverage — strictly dominated, and only visible because
the model is miscalibrated at the top. `CLASSIFY_CONFIDENCE_FLOOR_BPS=6000` is now a number
chosen from this table rather than by feel.

One more finding worth the slide: **the keyword classifier's only mislabels come from
prompt-injection strings.** It is never wrong on honest input — it is wrong exactly when the
text was written to mislead it.

Three things this table says that an accuracy figure alone cannot:

- **`opaque 0.0%` is correct, not a defect.** `"payment failed"`, `"GATEWAY_ERROR"`,
  `"declined"` genuinely do not name a cause. A rule mapping bare `"declined"` to
  `do_not_honour` would raise accuracy on paper and spend money on a cause nobody
  identified. Its deliberate absence is why the baseline quarantines instead of guessing.
- **Only 10 of 300 were actively mislabelled**; 142 were quarantined. The baseline fails
  *conservatively* — it forgoes opportunities rather than spending fees on wrong actions.
  Both are departures from the true cause and only one of them costs money to make, which
  is why the two columns are separate.
- **The oracle arm is why any of this has a scale.** Reported against it, "56.1% of
  achievable" is a claim; without it, "20.3% recovery" is a number floating free.

The keyword baseline is written to be a **fair opponent**: every rule comes from ISO 8583
codes and real gateway vocabulary, none from reading the corpus it is scored against. A
test enforces that in both directions — above 30% so the ablation is not a strawman, below
85% because near-perfect accuracy on a corpus containing an unreadable tier would mean the
rules were overfitted to it.

The LLM arm needs `ANTHROPIC_API_KEY`; without one it is **skipped, not estimated**.

> **Read B1 with care, and I will say this on the slide too.** B1 takes one attempt per
> failure; RC takes up to three. So part of RC's advantage is simply attempt count, not
> targeting. **B2** — fixed-schedule dunning at day 1 / 3 / 7, all causes treated alike —
> is the arm that isolates targeting from volume, and until it exists the headline
> comparison is incomplete. **B3**, the oracle, then supplies the ceiling that turns the
> claim from "we beat naive retry" into "we captured X% of what was achievable."

**What these numbers are, stated before you ask.** Simulated outcomes against a
probability model built from published sources (see [`docs/`](docs/)), not live gateway
results. What that proves: that the policy captures more net value than naive
alternatives *given* priors it was not allowed to see. What it does not prove: the
priors themselves. That is what the sensitivity sweep is for — it reports the share of
500 perturbed worlds in which the conclusion survives, and names the assumption it
depends on.

---

## Run it

Three commands, tested from a clean clone.

```bash
docker compose up -d     # Postgres 16 + Redis 7
pnpm install
pnpm demo                # migrate → seed → evaluate every arm
pnpm report              # → artifacts/report.html
```

### The console

```bash
pnpm web        # http://localhost:3100
```

A read-only operations console over the same Postgres data. **Server Components query the
database directly — there is no API layer**, which removes an entire tier and the drift that
comes with it. One client component exists, and only to highlight the active nav link.

| Route | What it shows |
|---|---|
| `/` | Net value, % of ceiling, all five arms, per-cause breakdown |
| `/exceptions` | Every refusal with its EV arithmetic, filterable by verdict |
| `/inbox` | What customers received, by DLT template and language — **and what was blocked, by which bound** |
| `/audit` | The append-only trail, grouped by actor |
| `/policy` | Version history and the proposal queue with decisions |

The inbox's blocked column is the important half: a compliance layer is only demonstrable if
you can see what it *stopped*. A system with no consent checks would render an identical
list of successful sends.

**`artifacts/report.html` is the evidence in one page** — 21 KB, no stylesheet, no script,
no network. It opens from a `file://` URL on a machine that has never seen this project.
Five-arm results, the value frontier, the 500-world sweep distribution, the hostile worlds,
the calibration reliability diagram, and every one of the 199 refusals with the arithmetic
that produced it.

Also available: `pnpm ablate` (classifier ablation in rupees), `pnpm sweep` (sensitivity +
hostile worlds), `pnpm propose` (the bounded improvement loop).

`pnpm demo` is `db:reset && seed && eval`. The steps also run individually; `pnpm eval`
**refuses** to run twice against the same batch, because a second run would continue the
first rather than repeat it and the summed figures would look plausible and mean nothing.

**Reproducibility, and what it cost to get right.** Three consecutive `pnpm demo` cycles
produce byte-identical results. That took more than seeding the generator: primary keys
were `gen_random_uuid()`, the attempt idempotency key hashes the transaction id, and the
simulator seeds each outcome draw from that key — so database-assigned identity was
feeding randomness straight into the results, and three runs of one seed gave three
different net-value figures. Identity is now a pure function of the seed
(`deterministicId`, UUID v8).

**Different data, same conclusion.** This is the claim that matters — the result is a
property of the policy, not of one convenient dataset:

| | Recoverable | RC rate | RC net | B1 net | RC ÷ B1 |
|---|---|---|---|---|---|
| `--seed 42` | 236 | 36.0% | ₹2,56,719.41 | ₹1,00,419.30 | **2.56×** |
| `--seed 99` | 239 | 25.5% | ₹1,48,080.33 | ₹55,311.12 | **2.68×** |

The absolute figures move a long way between seeds. The ratio barely moves.

Requires Node 22+, pnpm 9+, Docker. Copy `.env.example` to `.env` first; the process
validates its configuration at boot and fails immediately if anything is missing.

---

## Architecture

**→ [`ARCHITECTURE.md`](ARCHITECTURE.md) — thirteen diagrams, rendered.** The package graph and
the wall through it, the full refusal decision tree, one decision traced end to end, the
crash-resume protocol, the data model with every invariant the database enforces, the six-arm
harness, and the trust boundaries. Every name and edge in it is taken from the source.

```
revenue at risk → classify → POLICY ENGINE → EV GATE → BOUNDS → worker → audit
                     │            │                                        │
                   (LLM)    (deterministic)                        (append-only)
                     │
              low confidence → quarantine → cluster → propose taxonomy entry → human
```

**The hard line.** The LLM classifies noisy gateway strings, clusters unknown ones,
fills variables inside DLT-registered message templates, and proposes policy diffs for
human approval. Deterministic code makes every retry decision, every timing
calculation, every bound check, and every rupee of arithmetic. Non-deterministic
systems do not move money.

**The Chinese wall.** The policy engine's success priors and the simulator's ground
truth are separately sourced tables that never read each other — enforced by
`pnpm lint:boundaries`, which fails the build on violation. The policy is *permitted to
be wrong about the world*, which is the only condition under which a measured recovery
result means anything.

**No floating point in the money path.** Amounts are `BIGINT` paise behind a branded
`Paise` type with no `number` constructor. Margins *and probabilities* are integer basis
points, so the expected-value computation is integer arithmetic end to end.

Diagrams: [`ARCHITECTURE.md`](ARCHITECTURE.md). Build history:
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md). What broke:
[`FAILURES.md`](FAILURES.md).

---

## Build status

| Milestone | State |
|---|---|
| 0 · Foundation — monorepo, boundaries, money, schema, immutability | ✅ **verified against live Postgres** — 27 tests |
| 1 · The two walled halves — published priors, simulator, seed | ✅ **wall verified by injecting a breach** |
| 2 · The gates — `evGate`, `boundsCheck`, property tests | ✅ **54 tests**, two real gaps found by properties |
| 3 · Decision core — planner, idempotency, reconciliation | ✅ **69 tests** |
| 4 · **A number exists** — eval harness, arms RC/B0/B1 | ✅ **deterministic across 3 cycles** |
| 5 · Classifiers + ablation **in rupees** | ✅ keyword measured · LLM needs a key |
| 6 · Compliance + B2/B3 arms — consent, DLT, Hinglish, ceiling | ✅ **all five arms** |
| 7 · Sensitivity sweep — 500 worlds + threshold | ✅ **found a silent scheduling bug** |
| 7b · Hostile worlds | ✅ **all three degrade gracefully** |
| 7c · Calibration | ✅ **model is overconfident; threshold chosen from the curve** |
| 7d · Policy-proposal loop | ✅ **agent proposes, human decides, held-out measures** |
| 8 · Surface — generated report | ✅ **self-contained, offline, 4 charts** |
| 8b · Operations console — Next.js, 5 routes | ✅ **Server Components, no API layer** |
| 9 · **All five risk classes** — one engine, per-class proof | ✅ **found 7 bugs, 5 of which inflated our own numbers** |
| 9b · B4 messaging baseline + per-class ceiling | ✅ **the classes with no retry now have a real comparator** |
| 9c · Cost of the guardrails, in rupees | ✅ **88% of the shortfall is consent, and it is stated** |

---

## Verify

```bash
pnpm verify   # typecheck + lint + boundaries + tests
```

**138 tests, 12 files.** 20 skip cleanly with an explanation when Docker is not running rather
than failing with a wall of connection errors.

[`FAILURES.md`](FAILURES.md) records the bugs that mattered — what broke, how it was found, and
what it cost. Nineteen entries. **Five of them inflated this system's own reported results**,
and those are listed first, because a bug that flatters the author is the one a reader most
needs to know was looked for. Three were found by a robustness check rather than by a test,
which is the argument for having them: the interesting failures here were all silent.

- **The Chinese wall** is enforced in two independent layers, and both were verified by
  deliberately adding a forbidden import and confirming each one fails:
  1. `@typescript-eslint/no-restricted-imports`, scoped to the two packages, matching the
     import **specifier** — no module resolution involved, so nothing can be excluded out
     of the graph before the check runs. Type-only imports are banned too.
  2. `pnpm lint:boundaries` (dependency-cruiser), matching resolved paths plus an
     unresolvable-import rule that closes the case where the forbidden package was never
     added to the manifest.

  The first version of this used only resolved-path matching and **silently passed with a
  forbidden import in the file**, because a pnpm workspace import resolves through a
  `node_modules` symlink that the config excluded from the graph. Worth knowing: a
  boundary rule nobody has tried to break is not a boundary.
- **Property tests** — money sums tie · rounding is symmetric · attempt caps hold for
  any generated policy · contact ceilings hold for any batch · no send inside quiet
  hours at any offset · no send against an opt-out · concurrent workers never
  double-charge · the kill switch produces zero subsequent attempts.
- **Crash-resume tests** — `reconcileStranded` driven by a gateway that charges and then
  throws, leaving a `pending` decision exactly as a killed process would. Two cases needing
  opposite handling: charged-but-unrecorded must settle from the gateway's record and
  **never re-dispatch**; never-reached-the-gateway must re-dispatch under the same key
  rather than abandon a recoverable payment. Plus the lease, idempotency of a second pass,
  and the `attempt.reconciled` audit attribution.
- **Integration tests** — run against the real Postgres from `docker compose`, because
  the append-only triggers and `FOR UPDATE SKIP LOCKED` are exactly what a mocked
  database would let pass. Twelve of them currently assert that the schema refuses to:
  rewrite or truncate the audit trail, un-withdraw a consent, fire a decision without an
  idempotency key, reuse an idempotency key, move a settled decision back to pending,
  re-score a decision after its outcome is known, record recovery on a failed attempt,
  spend past the batch fee budget, or mark a message template registered without a DLT
  registration id.

---

## Data

**All synthetic.** Every customer, transaction and failure string in this repository is
generated from a seed. There is no code path by which real customer data enters, which
is why this repository can be public.

---

## Limitations

Stated here rather than discovered in review.

- Outcomes come from a simulator, not a live gateway. The sweep quantifies how much that
  matters; it does not remove it.
- Priors are drawn from public sources and, where none exists, marked `ASSUMED` and given
  the widest perturbation band. They are not fitted to any specific issuer.
- Durability is stateless workers plus Postgres state, not Temporal. That covers most of
  what a real deployment needs and is honestly short of the rest.
- Messaging effectiveness **is** now modelled, and that is the weakest-sourced part of the
  system. It had to be: four of the five risk classes recover money by messaging and nothing
  else, so excluding it would have scored most of the work at zero. Non-charging interventions
  therefore have their own prior rows — a payment link, a pre-debit notice and a
  re-authorisation request are three different questions with three different answers, and
  keying priors on the cause alone had quietly assumed every attempt was a charge.

  What that rests on: **a draw against a table, not a model of a person deciding to buy.**
  Every one of those rows is `ASSUMED`, gets the wider ±60% band in the sweep, and states its
  reasoning in [`priors.published.yaml`](packages/policy/priors.published.yaml). The
  *ordering* is the defensible part — an OTP drop-off recovers far better than an abandoned
  cart, a well-timed payment-run reminder better than a generic chase — and the sweep's job is
  to say how wrong the levels can be before the conclusion changes. The truth table
  deliberately sets every checkout figure *lower* than the published one, so the controller is
  optimistic about links in the world it is graded against.
- The **issuer effect is not applied to non-charging actions**, on purpose. A co-operative
  bank's flaky authorisation infrastructure is a real reason a debit fails; it has nothing to
  do with whether a customer taps a link. Applying the multiplier there would have been
  modelling noise dressed as rigour.
- `dlt_template_id` values are synthetic. Real registration is an operational step with a
  real operator.
- Single-tenant. Merchant onboarding, key management and per-merchant policy isolation
  are out of scope.
