# What broke, and what it cost

A record of the bugs that mattered, kept because the interesting ones on this system were
all **silent**: the code ran, the numbers looked plausible, and the conclusion was wrong.

Each entry says what the symptom was, how it was actually found, why it was expensive, and
what now prevents it. Several were found by a robustness check rather than by a test — which
is the argument for having them.

The ones marked **▲** inflated this system's own reported results. Those are recorded first
in each section, because a bug that flatters the author is the one a reader most needs to
know was looked for.

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
