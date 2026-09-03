# What broke, and what it cost

A record of the bugs that mattered, kept because the interesting ones on this system were
all **silent**: the code ran, the numbers looked plausible, and the conclusion was wrong.

Each entry says what the symptom was, how it was actually found, why it was expensive, and
what now prevents it. Several were found by a robustness check rather than by a test — which
is the argument for having them.

Two markers, because they are different kinds of bad:

- **▲** — the bug **inflated this system's own reported results**. Seven of them (1–7). A bug
  that flatters the author is the one a reader most needs to know was looked for.
- **▲▲** — the bug **disabled a guarantee that exists to prevent an inflated result**. One
  of them (20), and it is one level worse, because it removes the thing that would have caught
  the first kind.

Entries are numbered in the order they were found rather than by severity, so the markers and
not the position are how to find the ones that matter. **If you read one, read 20.**

Not every bug here flattered the system. **21** did the opposite: it made the model look
worthless when the honest finding was that it captures 97.8% of the achievable ceiling. An
error in that direction is just as much a reporting failure, and keeping only the flattering
ones would be its own kind of selective accounting.

---

## 1. ▲ Message-only actions fired without sending the message

**Symptom.** Nothing. The controller reported recovering 100.1% of the achievable ceiling on
checkout abandonment and 99.8% on lapsed mandates. Both looked like a triumph.

**What was happening.** `planNext` returns `fire` with `contact.send: false` whenever a
contact bound — consent, quiet hours, the weekly ceiling — suppresses the message. For a
*retry* that is exactly right, and it is a deliberate design decision: the charge proceeds
silently and the suppressed nudge is audited as its own event, because declining a good retry
for want of an optional SMS would be losing money to politeness.

For a payment link, a pre-debit notification or a re-authorisation request it is nonsense.
The message **is** the intervention. So "fired, sent nothing" had the simulator draw a
success probability for a link no customer ever received, and the controller was credited
with recoveries from messages it had itself decided not to send.

**Cost.** The effect was largest in precisely the classes that recover by messaging. Fixing
it moved checkout abandonment from 100.1% of ceiling to 3.2%, and lapsed mandates from 100.3%
to 25.9%. Two thirds of the reported recovery in those classes was phantom.

**How it was found.** Reading the per-class table and disbelieving it. A controller bounded by
consent, quiet hours and a weekly contact ceiling cannot capture ~100% of a ceiling that
ignores all three. The number was too good, and being too good is a symptom.

**Fixed by** refusing the action when the message it consists of cannot be sent —
[`plan.ts`](packages/engine/src/plan.ts), checked after the bounds and before the economics.
The same bug existed in both baseline arms and in the oracle; all three were fixed together,
since leaving it in a baseline would have flattered the baseline instead.

---

## 2. ▲ Cancelling a nudge instead of deferring it

**Symptom.** Immediately after fixing #1, the messaging classes collapsed to near zero.
Checkout abandonment recovered 3 transactions out of 62.

**What was happening.** A message-only action whose landing time fell inside quiet hours was
refused outright. Attempt landings are spread across the clock and quiet hours are 21:00–09:00
— half of it — so roughly half of every messaging schedule was destroyed before it reached the
expected-value gate.

**Why that was wrong.** Quiet hours must never be violated, and there are two ways to honour
them. Suppressing the message and letting the charge proceed is right for a retry. Cancelling
a payment link protects nobody: a link that would have arrived at 03:00 was always going to be
read after breakfast. Any real dunning system defers.

**Cost.** Cancelling instead of deferring cost the four messaging classes most of their
recoverable value. Deferring moved checkout abandonment from 3.2% of ceiling to 79.8% and
subscriptions from 2.3% to 49.8%.

**Fixed by** `deferPastLocalWindow` and `deferIntoLocalWindow` in
[`time.ts`](packages/core/src/time.ts), applied in the scheduler. Voice gets both, in order:
pushed out of quiet hours, then pulled into the much narrower window in which calling is
permitted at all.

---

## 3. ▲ The salary-window retry never fired

**The most expensive bug in the project's history.** ₹1.08 lakh of recoverable value, in
silence.

**Symptom.** None. The controller still beat every baseline. 141 refusals per batch were
audited with a correct-sounding reason.

**What was happening.** A timing bucket says how long after the FAILURE an attempt arrives —
`salary_window` means "48 to 96 hours after the payment failed", not "72 hours after the
previous try". Both runners advanced the clock cumulatively by the timing of the attempt just
fired. So `insufficient_funds` attempt 1 (`immediate`, 0.05h) put the clock three minutes past
the failure; attempt 2 then needed a 48-hour gap, saw 0.05 hours, and was refused as
`min_gap`. Every time, for every transaction.

The single intervention the entire strategy is built around never ran once.

**How it was found.** The sensitivity sweep produced a perfectly flat threshold curve. The
salary-window probability could not matter, because nothing ever consulted it. A flat line
where a parameter should bite is what a robustness check is for.

**Cost.** Recovery went from 62.4% of the achievable ceiling to 91.8% once fixed.

**Fixed by** [`schedule.ts`](packages/eval/src/schedule.ts), which schedules from the failure
instant. The module header carries the full story.

---

## 4. ▲ `card_expired` and `mandate_expired` written off as unrecoverable

**Symptom.** Both codes had an empty schedule and escalated. That looked correct — retrying an
expired card succeeds exactly zero percent of the time, forever.

**What was wrong.** `terminal` means *no re-presentment can succeed*. It says nothing about
whether the money is recoverable. Asking the customer for a new instrument, or for a fresh
mandate authorisation, is a different action with a real and non-trivial success rate. The
system was treating "cannot be retried" as "cannot be recovered" — the exact mirror of the
more famous error of retrying an expired card, and equally expensive.

The same conflation was structural: a prior was keyed on `(cause, attempt, timing)`, which
quietly assumed every attempt was a charge, and `mandate_expired` was declared a structural
zero full stop. The engine could not have priced a re-authorisation even if the policy had
scheduled one.

**Fixed by** giving priors a `kind` — `charge`, `payment_link`, `notify`, `pre_debit_notify`,
`remandate` — and scoping structural zeros to `charging` or `all`. Thirteen of the eighteen
reason codes are now terminal, and nine of those are among the most recoverable classes in the
system. `bounds.test.ts` pins the invariant that matters: the codes that moved off the
empty-schedule list did so by gaining a NON-charging schedule, and it still fails if someone
"fixes" an expired card by adding a retry step.

---

## 5. ▲ The oracle ceiling was unlawful, then unreachable, then wrong

Three separate defects in the measurement ceiling, found in sequence. The ceiling is what
turns "we beat naive retry" into "we captured X% of what was achievable", so a wrong ceiling
corrupts the headline claim in both directions.

**5a — the oracle skipped every terminal cause.** The line read
`if (isTerminal(input.reasonCode)) return null` — physics, not economics, nothing recovers an
expired card. True for a retry, and badly wrong once anything else was modelled: all nine
checkout and receivable causes are terminal because nothing was ever charged on them. The
ceiling for four of the five risk classes would have been exactly zero, and "% of achievable"
would have read as 100% — or divided by zero — precisely where the new work happens.

**5b — the oracle debited e-mandates with no pre-debit notification.** The oracle ignores the
expected-value floor, the attempt cap and the contact ceiling, because those are a merchant's
risk preferences and a ceiling exists to measure what was given up by choosing them. It was
also ignoring the pre-debit notification requirement, which is not a preference — it is the
condition under which an e-mandate debit is lawful at all. An oracle that debits without
notice is not a ceiling but a fantasy, and reporting the controller as a fraction of it
understated the controller by comparing it against something nobody is permitted to do.
Fixing it moved subscriptions from 34.6% of ceiling to 58.0%.

**5c — the ceiling was measured on net, and two classes exceeded 100% of it.** Impossible for
a ceiling, and the symptom of a real definitional problem: the oracle assumes every customer
is reachable, so it sends messages the controller's consent bounds suppress — and pays for
them. On a class where both recover the same transactions, the oracle's extra postage made its
*net* lower than the controller's. The ceiling is now measured on value recovered, which has
no such contamination, with cost shown beside it rather than baked into the ratio.

---

## 6. ▲ A whole population that was neither one thing nor the other

**Symptom.** `payment_failure` reported 59.2% of its ceiling, against 91.8% before the risk
classes were introduced. 78 of 108 transactions in the class were refused.

**What was happening.** 30% of one-off payment failures were generated as recurring, with a
mandate reference, by an independent coin flip on top of the class. Their class said "one-off
payment", so their strategy had no pre-debit notification step — and their mandate reference
made the engine require one. Every retry was refused with `pre_debit_notice`: correctly, since
debiting a mandate without notice is unlawful, and unrecoverably, since the policy for a
one-off never schedules a notice.

**Why it was really a modelling error.** A recurring card-on-file payment that fails *is* a
subscription failure. Recurrence is a property of the class, not an independent draw, and the
coin flip created a category the taxonomy had no answer for.

**Cost.** Removing the draw moved `payment_failure` from 59.2% of ceiling to 95.2%.

**Also fixed:** the database constraint `txn_recurring_has_mandate` had to be narrowed rather
than dropped. A recurring transaction needs a mandate reference *unless its authorisation is
the thing that lapsed* — the whole meaning of `mandate_lapsed` is that no live authorisation
exists, and writing a reference for one would make the row claim a mandate it does not have.

---

## 7. ▲ Baseline waste reported as ₹0.00

**Symptom.** The report said the blast-reminders baseline fired 511 negative-expected-value
attempts and spent ₹0.00 doing it.

**What was happening.** `negativeEvSpend` summed gateway fees only. That baseline pays no
gateway fees — it sends messages — so its entire waste was invisible, and the arm the
comparison exists to hold to account was flattered to exactly zero cost.

**Fixed by** joining message cost per decision in [`metrics.ts`](packages/eval/src/metrics.ts)
so a decision's waste is its fee **plus** its message. The figure became ₹107.26.

---

## 8. A legally required notice refused as a pointless nudge

**Symptom.** 29 pre-debit notifications per batch refused, and every subscription behind them
unrecoverable: no notice, therefore no lawful debit, therefore nothing.

**What was happening.** `issuer_down`, `do_not_honour` and `network_timeout` are all
`notifiable: false` in the taxonomy, for a good reason — nothing the customer does affects an
issuer outage, so telling them about it is noise. But that reasoning is about a message
*describing the failure*. A pre-debit notification is not a nudge; it is what makes an
e-mandate debit lawful, and whether the customer can act on the underlying failure is beside
the point.

One flag was answering two different questions.

**Fixed by** splitting `mayEverContact` into `isNeverContact` (compliance, absolute, nothing
overrides it) and `isNotifiable` (a judgement about usefulness, which a mandatory notice
overrides). Subscriptions moved from 49.8% of ceiling to 67.5%.

**How it was found.** By querying the refusal reasons per risk class instead of guessing at
them — which is also why `decision.refuse_rule` now exists as a column.

---

## 9. The Chinese wall silently passed a real breach

**The worst kind of bug: a check that reports success while checking nothing.**

**Symptom.** `pnpm lint:boundaries` passed. The wall was not enforced.

**What was happening.** `exclude: node_modules` in the dependency-cruiser config deleted the
edge before any rule could see it. In a pnpm workspace, `@rc/policy` resolves through
`node_modules/@rc/policy` — a symlink — so the one import the rule existed to forbid was the
one import it could not see.

**Fixed by** two independent layers that must both pass: an ESLint
`no-restricted-imports` rule on the import specifier, and a dependency-cruiser rule with
`reachable: true` on the resolved graph, plus `no-unresolvable` so a module the cruiser cannot
resolve fails the build rather than passing quietly. A single mechanism guarding the property
the whole measurement rests on was one too few.

**Then it caught a real transitive breach** — `simulator → engine → policy` — which was fixed
by moving the `Gateway` port into `@rc/core`.

---

## 10. Non-determinism leaking in through primary keys

**Symptom.** Three runs of the same seed produced three different net-value figures. The
README claims reproducibility.

**What was happening.** `gen_random_uuid()` primary keys made the DATA reproducible while
leaving IDENTITY random. The attempt idempotency key hashes the transaction id, and the
simulator seeded its outcome draw from that key — so randomness reached the outcomes through
the back door.

**Fixed by** `deterministicId` (UUID v8, derived from seed/arm/world/index).

---

## 11. The ablation was not controlled

**Symptom.** The measured cost of imperfect classification was ₹39,065. Plausible, and wrong.

**What was happening.** Transaction ids encoded the arm and the world, and the outcome draw
keyed on the id — so each arm faced a *different* set of coin flips. Part of every measured
gap was luck rather than strategy.

**Fixed by** migration 011: outcome draws key on `logical_ref`, the transaction's
world-independent position in the seeded population. Every arm now meets the same sequence of
successes and failures.

**Cost.** The properly controlled gap was ₹58,487 — nearly 50% larger than the uncontrolled
figure. The bug had been *understating* the result, which is the direction that matters least
and is still a wrong number.

---

## 12. The sweep quietly measured a different, more permissive system

**Symptom.** The parity test between the in-memory sweep and the database runner failed: 275
attempts against 193.

**What was happening.** The sweep is the robustness check — it reruns the comparison in 500
worlds and reports the share in which the conclusion survives. It only means anything if it is
measuring *this* system. It was handing every arm a universal registered template and
`opt_in` consent, on the grounds that messaging was excluded from it anyway. Once four of the
five risk classes recovered money by messaging, that shortcut made the sweep a confident
statement about the robustness of a system in which nobody had opted out and every template
existed.

**Three things had to become genuinely shared** rather than approximately similar:

- **The population.** Consent, language and the NCPR flag moved into `planTxns`, so both paths
  read one book of customers instead of drawing their own.
- **Template resolution.** The sweep resolves the step's template and language variant from the
  same seed list the database is seeded from, so it cannot send what the run cannot.
- **The order.** Contact ceilings are per customer, so processing order decides which sends are
  permitted. The runner tied on the primary key — a hash, unreproducible in memory — and the
  two paths disagreed by exactly one attempt in two hundred. Both now tie on the generation
  index.

**And a last 126 paise** — exactly seven SMS. The sweep broke out of its loop on a refusal
without charging the escalation message the persisted path sends: an escalation is a contact
with no attempt, and the sweep ran seven messages cheaper than the run it claims to reproduce.

Parity on attempts and recoveries is now exact, and net value differs by exactly one
documented quantity: the subscription horizon basis.

---

## 13. A policy edit that silently rewrote the wrong setting

**Symptom.** A test expecting `applyChanges` to throw stopped throwing.

**What was happening.** The module applies approved policy proposals to the YAML. It exists
because a silent failure there is invisible and catastrophic: the held-out evaluation would
compare a policy against ITSELF, report a delta of exactly zero, and look for all the world
like an honest negative result.

The edit was a regex scoped to a reason code's block only by a lazy quantifier stopping at the
first match. That held while each code appeared once in the file, and stopped holding the
moment per-risk-class overrides arrived — a code can now appear both under `reason_codes:` and
again, more deeply indented, under `class_overrides:`. Asking to change
`card_expired.min_gap_hours`, which has no such line in its base block, let the match run past
the end of the block and rewrite the *subscription override's* value instead. No error, wrong
setting changed.

**Fixed by** locating the block structurally, line by line, in
[`apply-policy.ts`](packages/eval/src/apply-policy.ts): the key at exactly two spaces of
indentation, ending at the next line indented no further. A match outside those bounds is not
a near miss to be tolerated, it is a different setting.

---

## 14. A stale copy of the taxonomy in the web console

**Symptom.** None visible. The console showed a recovery rate.

**What was happening.** `queries.ts` carried a hardcoded `TERMINAL` set — a copy of four
reason codes — and used it as the *denominator* of the recovery rate. Once the taxonomy grew
to eighteen codes, the copy counted nine recoverable classes as unrecoverable and inflated the
rate the console displays, while the report next to it used the correct denominator.

Two numbers on one submission disagreeing about the same batch is worse than either being
wrong.

**Fixed by** reading the real prior table, using the same predicate `computeMetrics` uses, so
the console and the report cannot drift again.

**Found by** pointing ESLint at the web app, which the lint tsconfig had never included —
`apps/*/src/**` does not match `apps/web/app/**`. The console had never been linted.

---

## 15. "Best baseline" could report the controller's own number

**What was happening.** The overview page computed the best baseline with
`.reduce((best, a) => ..., arms[0]!)`. The seed participates in the comparison, and `arms[0]`
is whichever arm the query returned first — `b0` in practice, but it could be the controller
or the oracle. The headline callout could have compared the controller against itself.

The non-null assertion is what let it through review: it silenced the question of what happens
when there are no baselines, and that was the question worth asking.

---

## 16. Escalation messages that were never sent

**Symptom.** Nine messages sent per batch. Fifty-one transactions per batch were escalating
with `notify_on_escalate: true`.

**What was happening.** `recordRefusal` dropped `plan.contact`. The escalation path — which is
the *entire* intervention for a terminal cause — recorded a decision and sent nothing.

**Fixed**, and sends went from 9 to 42 per batch.

---

## 17. Reconciliation matched nothing, and looked fine

**Symptom.** The crash-resume test passed. Reconciliation found no stranded decisions.

**What was happening.** `decision.updated_at` defaulted to `now()` — the database's wall clock
— while every other timestamp in a simulated run is on the caller's clock, which is set in
June 2026. The reconciliation lease compares against that column, so it was comparing a 2026
cutoff against a 2025 wall clock and matching nothing. The demonstration appeared to succeed
while proving the opposite of its claim.

**Fixed by** migration 008: `updated_at` is written explicitly from the caller's clock.

---

## 18. A phantom SMS cost in the baseline arithmetic

**Symptom.** None; found by reading.

**What was happening.** The baseline arms never contact anyone, and their expected-value
pricing charged an SMS anyway. That understated every baseline's expected value by ₹0.18 an
attempt and pushed more of them below zero than truly were — inflating the "negative
expected-value attempts" figure **in favour of the controller**, which is the one direction a
comparison like this must not be wrong in.

**Fixed.** It changed nothing material, and it is recorded because the direction of the error
mattered more than its size.

---

## 19. Cold-start failures nobody would have hit twice

A cluster of small things that each broke the documented three-command path for a first-time
reader, and would have broken it for a judge:

- `.env: not found` — every entry point now defaults rather than requiring the file.
- `db:reset` ran before `build`, so it executed a stale migrator.
- `EVAL_SEED` was required by `seed` alone, while every other entry point defaulted to 42.
- The report was not part of `pnpm demo`.
- Integration suites **failed** rather than skipping when Docker was not running — because
  `createDb` is lazy, so the connection error surfaced as a wall of test failures that looked
  like broken code. `isDatabaseReachable()` now gates them: 20 skip cleanly with an
  explanation.
- I wrote UTF-8 BOMs into `package.json` and three other files with PowerShell's
  `Set-Content -Encoding utf8`, which broke dependency-cruiser. All stripped.

---

## 20. ▲▲ The Chinese wall's second layer had never run

The worst defect found on this project, and it was in the thing the project is proudest of.

**Symptom.** None available. The README, `ARCHITECTURE.md` and the landing page all claimed
the wall was enforced by **two independent checks** — an ESLint rule on the import specifier
and a dependency-cruiser rule on the resolved graph. Every run of `pnpm lint:boundaries` had
passed for the life of the repository, which is exactly what a working check looks like.

**How it was found.** By injecting the breach rather than by reading the config. With
`import { loadTruthModel } from '@rc/simulator'` at the top of `packages/policy/src/ev.ts`,
the dependency declared in `package.json` and a `tsconfig` reference added,
`pnpm lint:boundaries` reported *"no dependency violations found (113 modules, 210
dependencies cruised)"* — and the JSON graph showed `ev.ts` with **zero dependencies**. Not
the wrong ones; none at all. Only ESLint objected.

So "two independent layers" was one layer and a decoration, and every `reachable: true` rule
in the file was inert: `chinese-wall-policy-to-sim`, `chinese-wall-sim-to-policy`,
`no-simulator-in-production-paths`, `razorpay-client-decides-nothing`,
`no-razorpay-in-the-measurement`.

**Why.** pnpm resolves a workspace import through `packages/policy/node_modules/@rc/core`;
dependency-cruiser follows that symlink to its real target, so the edge arrives as
`packages/core/dist/index.js`. `dist` was excluded — and `exclude` **deletes** a module from
the graph rather than keeping it as a leaf, which is the distinction the config's own header
note was already warning about. Every workspace edge vanished before a rule could see it. 210
of the "dependencies cruised" were intra-package; the graph was nine disconnected islands.

**What it cost.** Nothing measured, and that is the point: had a forbidden import ever been
added, the check that exists to catch it would have passed, and every recovery number here
would have been a tautology dressed as an inference. The config's header note said excluding
node_modules was what broke the wall the first time. The note was right, and the pattern did
it again one directory deeper.

**Two dead ends, recorded because each looked right.** Anchoring the exclusion to
`packages/*/dist` changes nothing — symlink resolution is exactly what lands edges there.
Dropping the exclusion entirely puts compiled output in the graph, where the parser dies on
`Unexpected template string` and then *no* rule runs at all.

**What prevents it.** `tsconfig.depcruise.json` maps `@rc/*` to `packages/*/src/index.ts`, so
a cross-package import resolves to source: the graph is source-to-source, `dist` stays
excluded, and reachability has a connected graph to search. Kept out of `tsconfig.base.json`
deliberately — `paths` there would let a developer import across packages without declaring
the dependency and have the build accept it, trading one silently-disabled guarantee for
another. Both walls re-verified by injection rather than inspection:

| | before | after |
|---|---|---|
| dependencies cruised | 210 | **337** |
| violations on an injected `policy → simulator` breach | **0** | 99 |
| violations on an injected `detect → simulator` breach | 0 | 27 |

**The general lesson.** A rule nobody has tried to break is not a rule. This is the second
time on this project that a guarantee passed while being violated, and both times the rule
was written correctly and evaluated over the wrong graph.

---

## 21. A rate limit reported as a cautious model

**Symptom.** The first live LLM ablation said the model was worthless: level with a free
keyword table, having declined to label 26 of 40 transactions. That reads as a conservative
classifier earning its quarantine threshold.

**How it was found.** By querying `llm_call` for the failure reasons behind the quarantines.
Thirteen of the 26 were Groq HTTP 429s; on Gemini it was 19 of 40.

**Why it was expensive.** A call that never happened arrived at the report identically to one
where the model read the string and abstained — both surface as `quarantined: true` with
`reasonCode: 'unknown'`. The report was describing throttling and calling it judgement, which
is a conclusion about the wrong thing entirely. No ▲: this one ran in the other direction and
understated the system, which is exactly as much a reporting failure.

**What it cost.** With the calls actually landing (25 of 25, zero failures) the finding
inverts. Same policy, same population, only the classifier swapped:

| classifier | accuracy | on hard strings | % of legal ceiling | model cost |
|---|---|---|---|---|
| keyword | 56.6% | 68.6% | 26.5% | ₹0.00 |
| gemini-3.1-flash-lite | 69.9% | **94.1%** | **97.8%** | ₹0.25 |

**What prevents it.** Transport failures are counted apart from quarantines and `pnpm ablate`
gained a `failed` column, so a throttled run is visible as one. The retry ceiling went from
8s over 4 attempts to 15s over 6 — free tiers throttle by the minute and waiting is the only
thing that helps — and `CLASSIFY_CONCURRENCY` defaults to 2, because without jitter every
worker in a throttled window comes back at the same instant and is throttled again.

---

## 22. Detection that changed nothing

**Symptom.** The degradation detector found both seeded episodes with 100% precision and
recall, and changed **not one decision**. Every table said it worked.

**How it was found.** By querying `decision.refuse_rule` for the two bounds the detector is
supposed to create, and getting zero rows.

**Why.** The authorisation stream is a ten-hour band; the 300 recovery cases are drawn
independently across seven days. So essentially none of them belonged to an affected cohort at
an affected time, and the signal had nothing to act on.

**What it cost.** Nothing yet, and it was one commit from costing the submission its
credibility — a feature wired up and never firing is worse than an absent one, because the
wiring reads as evidence.

**What prevents it.** The temptation was to widen a threshold until something happened, which
would have manufactured the effect. The fix models the real pipeline instead: an outage
*causes* a burst of failures, and those failures *are* recovery cases. `planOutageCases` seeds
14 per material episode, inside the window, on the affected cohort — modest on purpose, since
an outage cohort large enough to move the headline would be choosing the result rather than
showing the mechanism. The signal is now load-bearing: 9 `issuer_degraded` refusals, 2
`fraud_rule_active`, and `switch_rail` up from 32 to 35 — the detection changing the *action*
rather than merely suppressing one.

**A second bug inside the first.** `loadAuthStream` joined only `classification`, which exists
for the few hundred triaged failures out of fourteen thousand. Every signal therefore carried
`dominantCode: null`, and the fraud-rule episode was reported as an issuer outage — the right
cohort with the wrong cure, which is the one combination that actively harms: switching rails
to evade a risk engine is futile, and at volume it is how a merchant loses its acquirer.

---

## 23. Prompt-injection resistance we assumed and never had

**Symptom.** `strings.ts` had promised since it was written that "any classification of one is
recorded so the report can state how the system behaved under attack instead of claiming it
was never tried." No number anywhere said what happened to them; a test asserted only that the
attacks parse safely.

**How it was found.** By writing the measurement the comment promised — and then finding the
first version of it worthless.

**Why the first version was worthless.** It read the persisted batch: join the planted
descriptions to their classifications and count how many got the demanded label. It reported
**zero steered**, which looks like a security result and measured nothing. `pnpm eval`
classifies with the **oracle**, which reads the simulator's seeded cause and never looks at
the description. An attack cannot steer a classifier that does not read it.

**What the real measurement says.** Against the keyword classifier over the declared corpus,
**3 of 4** label-naming attacks land their demand exactly. "The keyword baseline cannot be
steered, because it has no instruction-following surface" is true and irrelevant: it cannot be
*persuaded*, and it is steered anyway by the cheaper attack — write `network_timeout` into the
text and a keyword matcher will match it.

**Why that is worth publishing.** It points against the convenient answer. The free classifier
is not the conservative choice here; it is the one that loses to a single line of text, which
belongs beside its 26.5%-of-ceiling economics rather than buried. The one attack it resists is
resisted for an accidental reason — a genuine cause sits in front of the demand and the
matcher reaches it first — so the resistance is an artifact of keyword order rather than
judgement, and a test now pins that distinction.

**What holds absolutely, and what does not.** Output is validated against the taxonomy before
anything reads it, and `classification.reason_code` is a foreign key to the seeded
`reason_code` table, so a code outside the eighteen cannot be stored. And a cause only ever
*indexes into* the policy — it selects a schedule row, it cannot become one — which is why the
attack demanding "unlimited retries" has nothing to attack. Neither layer covers being steered
to a label that IS in the taxonomy but wrong, and the report now states the size of that gap
instead of implying it is closed.

---

## 24. A layout comment describing a fix that was never written

**Symptom.** The landing page's agent-loop band rendered with columns roughly 60px wide,
wrapping one word per line, rows visibly misaligned.

**Why.** `.flow` is a five-track grid — `1fr auto 1fr auto 1fr`, so steps stretch and
connectors take 34px — which means one row holds exactly three steps and two connectors, and
the child count must be a multiple of five. Going from three steps to six gave it **eleven**
children. Row one filled correctly, then row two started one track late, so every step landed
in a 34px connector track.

**What made it worse.** The CSS comment left beside it described "an explicit 11-column track"
as though that were the fix. It was never written — the template still said
`1fr auto 1fr auto 1fr`. A comment asserting a layout the file does not have is how the next
reader spends an hour looking in the wrong place, and it is the same failure mode as entries
20 and 23: an assertion in prose that no check was holding to account.

**What prevents it.** The connector between 03 and 04 is gone, so there are ten children and
two rows exactly in phase — verified against the rendered DOM rather than by eye. A
`:nth-of-type(3)` rule meant to rotate the row-ending connector was also removed:
`nth-of-type` counts among siblings of the same element type, and every child there is a
`div`, so it was rotating an arbitrary arrow.

---

## Things this list does not claim

The bugs above were found. There is no reason to believe the set is complete, and two known
weaknesses are worth naming rather than leaving to be discovered:

- **The priors are mostly `ASSUMED`.** Every such row carries a written justification and gets
  the wider perturbation band in the sweep, and the mechanism that widens it is real and
  tested. The citations are research debt, and the sweep exists precisely to name the point at
  which an assumption stops being load-bearing.
- **The truth model has no notion of a customer changing their mind.** A payment link's success
  probability is a draw against a table, not a model of a human deciding to buy. That is stated
  in the README's limitations and it bounds what any of these numbers can mean.
