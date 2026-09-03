# Architecture

**Recovery Controller** — expected-value gated revenue recovery.
Razorpay AI Buildathon 2026 · Track 03

Every diagram below renders natively on GitHub. Every package name, table name, enum value and
edge is taken from the code, not drawn from memory — the dependency graph in §2 is the output
of `pnpm lint:boundaries`, which is the same check that fails the build.

---

## Contents

1. [The agent loop](#1-the-agent-loop) — detect, determine, execute, and the exit
2. [Package graph](#2-package-graph) — the real module dependencies, and the wall through them
3. [The Chinese wall](#3-the-chinese-wall) — why the numbers carry information
4. [One decision, end to end](#4-one-decision-end-to-end) — the path a single failure takes
5. [The gate and the bounds](#5-the-gate-and-the-bounds) — every reason an action can be refused
6. [Five risk classes, one engine](#6-five-risk-classes-one-engine) — what generalises and what differs
7. [The dual-write problem](#7-the-dual-write-problem) — crash-resume, and why it cannot guess
8. [Data model](#8-data-model) — tables and the invariants they enforce
9. [The evaluation harness](#9-the-evaluation-harness) — six arms, one population, a ceiling
10. [The improvement loop](#10-the-improvement-loop) — the agent proposes, a human decides
11. [Runtime topology](#11-runtime-topology) — what processes exist and what they touch
12. [Where the AI is, and is not](#12-where-the-ai-is-and-is-not)
13. [Trust boundaries](#13-trust-boundaries)

---

## 1. The agent loop

The brief asks for an agent that **detects** revenue at risk, **determines** the right
intervention, and **executes a bounded recovery workflow**. Those three verbs are the loop.

```mermaid
flowchart LR
    subgraph DETECT["① DETECT — population"]
        S["Authorisation stream<br/>14,000 attempts<br/><i>both outcomes</i>"]
        S --> W["Rolling 30-min window<br/>per issuer × rail"]
        W --> P{"Cohort vs its PEERS<br/>same rail, same window"}
        P -->|"Wilson lower bound<br/>clears baseline"| SIG["Signal<br/>outage · fraud rule · rail"]
        P -->|"41 of 47 cohorts"| OK["No alert"]
    end

    subgraph DETERMINE["② DETERMINE — per transaction"]
        T["One failure<br/>₹ amount · a customer"] --> DX["Diagnose<br/><i>18 causes, or unknown</i>"]
        DX --> EV{"Expected value<br/>≥ floor?"}
        EV -->|"no"| REF["Refuse<br/><i>and record the arithmetic</i>"]
        EV -->|"yes"| BD{"Permitted?<br/>consent · window · caps<br/>law · <b>the cohort</b>"}
        BD -->|no| REF
    end

    subgraph EXECUTE["③ EXECUTE — bounded"]
        ACT["Act, once<br/>retry · switch rail · link · notice"]
        ACT --> OUT["Outcome + audit row"]
        REF --> OUT
        OUT --> STOP{"EV still above floor?"}
        STOP -->|no| DONE["Stop"]
    end

    SIG -.->|"changes the action,<br/>not just the odds"| BD
    BD -->|yes| ACT
    STOP -->|yes| T

    style P fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style EV fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style BD fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style STOP fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style REF fill:#3f1d2e,stroke:#fb7185,color:#ffe4e6
    style ACT fill:#064e3b,stroke:#34d399,color:#d1fae5
    style DONE fill:#064e3b,stroke:#34d399,color:#d1fae5
    style SIG fill:#422006,stroke:#fbbf24,color:#fef3c7
```

Two things about that diagram are the whole submission.

**The dotted edge points at a bound, not at a probability.** A detected outage does not make
the engine *less optimistic* about a retry — it forbids the re-presentment and lets the rail
switch through. The population changes the **action**, which is what "root cause → recovery
action" means and what no per-transaction rule can do.

**The loop's exit is a gate, not a counter.** Most systems respond to a failure by retrying,
and a card retry costs ₹3.50 whether it works or not — so retrying everything can spend more
than it collects. This one prices each candidate action first and **usually declines**: on
seed 42, of 544 decisions across 328 transactions, 296 fired and **248 were refused**.

```
  probability × (amount × contribution margin)  −  cost  ≥  floor
```

Three properties follow from that line, and they are the whole design:

```
  probability × (amount × contribution margin)  −  cost  ≥  floor
```

Three properties follow from that line, and they are the whole design:

- **Margin, not gross.** Recovering a rupee is worth its margin. A ₹4 lakh invoice at 8% and a
  ₹499 subscription at 26% over six remaining cycles are closer in value than their sizes look.
- **Stopping is derived, not configured.** No `maxAttempts` constant does the real work. A
  sequence ends when expected value crosses the floor. The schedule length remains a hard
  ceiling, but on most transactions economics binds first.
- **Integers end to end.** Paise as `bigint`, probabilities and margins as basis points. There
  is no floating-point number in the money path and no constructor that would let one in.

---

## 2. Package graph

Nine packages and one app. The edges below are the actual `@rc/*` dependencies declared in each
`package.json`, and the two forbidden edges are the ones `pnpm lint:boundaries` fails on.

```mermaid
flowchart TD
    subgraph shared["shared vocabulary — depends on nothing"]
        CORE["<b>@rc/core</b><br/>money · ids · taxonomy<br/>risk classes · time<br/>Gateway port"]
    end

    subgraph persistence["persistence"]
        DB["<b>@rc/db</b><br/>schema · 14 migrations<br/>typed client · triggers"]
    end

    subgraph observe["the observing half"]
        DETECT["<b>@rc/detect</b><br/>rolling windows · Wilson bound<br/>peer baselines · scoring"]
    end

    subgraph decide["the deciding half"]
        POLICY["<b>@rc/policy</b><br/>published priors<br/>EV gate · bounds"]
        ENGINE["<b>@rc/engine</b><br/>plan · execute<br/>idempotency · reconcile"]
        AI["<b>@rc/ai</b><br/>classifier · proposer"]
    end

    subgraph world["the world"]
        SIM["<b>@rc/simulator</b><br/>ground truth · generator<br/>gateway sim · templates"]
        RZP["<b>@rc/razorpay</b><br/>live Payment Links<br/>test mode only"]
    end

    subgraph measure["measurement"]
        EVAL["<b>@rc/eval</b><br/>arms · runner · metrics<br/>sweep · ablation · report"]
    end

    subgraph surface["surface"]
        WEB["<b>apps/web</b><br/>Next.js console<br/>7 routes"]
    end

    DB --> CORE
    POLICY --> CORE
    AI --> CORE & DB
    SIM --> CORE & DB
    RZP --> CORE & DB
    DETECT --> CORE & DB
    ENGINE --> CORE & DB & POLICY
    EVAL --> CORE & DB & POLICY & ENGINE & AI & SIM & DETECT
    WEB --> CORE & DB & POLICY

    POLICY -.->|"⛔ FORBIDDEN"| SIM
    DETECT -.->|"⛔ FORBIDDEN"| SIM
    EVAL -.->|"⛔ FORBIDDEN"| RZP

    style CORE fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style POLICY fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    style SIM fill:#3f1d2e,stroke:#fb7185,color:#ffe4e6
    style RZP fill:#422006,stroke:#fbbf24,color:#fef3c7
    style DETECT fill:#164e63,stroke:#67e8f9,color:#cffafe
    style EVAL fill:#1e1b4b,stroke:#818cf8,color:#e0e7ff
```

`@rc/core` depends on **nothing**, and that is load-bearing rather than tidy. It is the only
package both sides of the wall may import, which makes it the only safe home for the `Gateway`
port — the one contract the policy engine and the simulator must both see.

The port lived in `@rc/engine` once. The simulator imported it, the engine imports `@rc/policy`,
and that produced a two-hop path from the simulator to the policy engine that every
direct-edge rule waved through. The rules are written on **reachability** because of it.

---

## 3. The Chinese wall

The single most distinctive property of this system, and the reason any measured number here
carries information rather than restating an assumption.

```mermaid
flowchart LR
    subgraph left["what the policy BELIEVES"]
        PP["<b>priors.published.yaml</b><br/>———<br/>salary-window retry: 4500 bps<br/>every row cites a source,<br/>or says ASSUMED and why<br/>———<br/>ASSUMED rows get the<br/>wider ±60% sweep band"]
    end

    subgraph right["what the world DOES"]
        PT["<b>priors.truth.yaml</b><br/>———<br/>salary-window retry: 4100 bps<br/>varies by issuer — information<br/>no gateway would disclose<br/>———<br/>read only by the oracle arm"]
    end

    PP -.->|"cannot import"| PT

    ESLINT["<b>layer 1 · ESLint</b><br/>no-restricted-imports<br/>matches the import SPECIFIER<br/>no resolution involved"]
    DEPCRUISE["<b>layer 2 · dependency-cruiser</b><br/>reachable: true on the<br/>RESOLVED graph, plus<br/>no-unresolvable"]

    ESLINT --> BUILD["build fails"]
    DEPCRUISE --> BUILD

    style PP fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    style PT fill:#3f1d2e,stroke:#fb7185,color:#ffe4e6
    style BUILD fill:#450a0a,stroke:#fb7185,color:#ffe4e6
```

**Why two layers.** The first version used only resolved-path matching, and it *silently passed
with a forbidden import in the file*. In a pnpm workspace `@rc/policy` resolves through a
`node_modules` symlink, and the config excluded `node_modules` from the graph — so the one
import the rule existed to forbid was the one import it could not see.

A boundary nobody has tried to break is not a boundary. Both layers were verified by
deliberately adding the forbidden import and confirming each fails independently.

**What the wall buys.** If the policy could read the truth, "our strategy won" would be an
identity rather than a measurement. The policy is *permitted to be wrong*, and the sensitivity
sweep in §9 measures how wrong it can be before it stops paying for itself.

---

## 4. One decision, end to end

The path a single failed payment takes. Nine steps, each in one package.

```mermaid
sequenceDiagram
    autonumber
    participant SIM as @rc/simulator
    participant AI as @rc/ai
    participant POL as @rc/policy
    participant ENG as @rc/engine
    participant GW as Gateway port
    participant DB as Postgres

    SIM->>DB: seed txn + failure_event<br/>(deterministic id, logical_ref)
    Note over SIM,DB: true cause written where no<br/>decision path can reach it

    AI->>AI: read gateway_description<br/>"51 NSF paisa nahi tha"
    AI->>DB: classification → insufficient_funds<br/>+ calibrated confidence
    Note over AI: output is a Zod ENUM —<br/>a model can index the taxonomy,<br/>never emit an instruction

    ENG->>DB: load observed history<br/>attempts · contacts · consent · promise
    ENG->>POL: scheduleEntry(cause, attempt, riskClass)
    POL-->>ENG: retry @ salary_window
    ENG->>POL: prior(cause, attempt, timing, kind)
    POL-->>ENG: 4500 bps — PUBLISHED, never truth

    ENG->>POL: evGate(amount, margin, cycles, p, costs, floor)
    POL-->>ENG: pass — net clears the floor

    ENG->>POL: checkAttemptBounds + checkContactBounds
    POL-->>ENG: allow

    rect rgb(20, 40, 60)
    Note over ENG,DB: TX 1 — reserve
    ENG->>DB: decision(pending) + fee hold + audit
    end

    ENG->>GW: attempt(idempotencyKey, amount, rail, context)
    GW-->>ENG: outcome

    rect rgb(20, 40, 60)
    Note over ENG,DB: TX 2 — settle
    ENG->>DB: outcome + decision(settled) + message_send + audit
    end
```

**Classification happens once per transaction, not per attempt.** A retry does not re-diagnose
the original failure, and re-classifying would multiply model cost by attempt count to produce
the same answer.

**A quarantined transaction arrives at step 5 as `unknown`**, whose policy entry permits no
attempts and escalates. No intervention fires on an unidentified cause.

---

## 5. The gate and the bounds

Every reason an action can be refused, in the order they are checked. **Order is the design:**
authorisation before economics, because there is no point pricing an action nobody is permitted
to take. A transaction blocked by quiet hours should report quiet hours, not a marginal
expected value.

```mermaid
flowchart TD
    START(["candidate action"]) --> KS{kill_switch}
    KS -->|engaged| R1["refuse_kill_switch"]
    KS -->|clear| LEGAL{"intervention legal<br/>for this risk class?"}

    LEGAL -->|no| R2["refuse_terminal<br/><i>illegal_intervention</i>"]
    LEGAL -->|yes| PROM{"open promise-to-pay<br/>not yet due?"}

    PROM -->|open| R3["refuse_bounds<br/><i>await_promise</i>"]
    PROM -->|none| NOTICE{"e-mandate debit with a<br/>pre-debit notice ≥24h old?"}

    NOTICE -->|missing| R4["refuse_bounds<br/><i>pre_debit_notice</i>"]
    NOTICE -->|ok| CAP{"within attempt cap<br/>and min gap?"}

    CAP -->|no| R5["refuse_bounds<br/><i>attempt_cap · min_gap</i>"]
    CAP -->|yes| FEE{"batch fee budget<br/>remaining?"}

    FEE -->|exhausted| R6["refuse_bounds<br/><i>batch_fee_budget</i>"]
    FEE -->|yes| MSG{"action IS a message,<br/>and the message is blocked?"}

    MSG -->|blocked| R7["refuse<br/><i>consent · quiet_hours<br/>contact_ceiling · ncpr_registry<br/>voice_window · voice_ceiling<br/>never_contact · no_template</i>"]
    MSG -->|sendable| EV{"p × value − cost<br/>≥ floor?"}

    EV -->|no| R8["refuse_ev<br/><i>ev_floor</i>"]
    EV -->|yes| FIRE(["FIRE"])

    style START fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style FIRE fill:#064e3b,stroke:#34d399,color:#d1fae5
    style R1 fill:#450a0a,stroke:#fb7185,color:#ffe4e6
    style R2 fill:#3f1d2e,stroke:#fb7185,color:#ffe4e6
    style R7 fill:#3f1d2e,stroke:#fb7185,color:#ffe4e6
    style R8 fill:#422006,stroke:#fbbf24,color:#fef3c7
    style EV fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
```

**Two bound checks, not one, and the split is deliberate.** `checkAttemptBounds` asks *may this
attempt happen?*; `checkContactBounds` asks *may this customer be messaged right now?* A retry
at 03:00 is fine; the SMS about it is not. Collapsing them would mean quiet hours silently
costing recoveries — declining a good retry because an optional nudge was blocked.

**The exception is a message-only action.** For a payment link, a pre-debit notice or a
re-authorisation request, the message *is* the intervention — so a blocked contact means the
action does not happen. Getting that wrong inflated this system's own reported results by two
thirds on the messaging classes; see `FAILURES.md` §1.

**Every refusal carries its arithmetic and its rule.** `decision.refuse_rule` is a column, so
"what did the consent bound cost us this batch?" is a query. The answer is **₹1,70,547 of
expected recovery, 88% of the entire shortfall against the ceiling** — stated in the report
rather than left as an unexplained gap.

---

## 6. Five risk classes, one engine

The brief names seven directions across three domains. They are the same shape of problem: an
amount of money attached to a customer, with a cause, on which a bounded and priced
intervention may be attempted.

```mermaid
flowchart TD
    subgraph engine["ONE decision path"]
        direction LR
        E1["classify"] --> E2["look up strategy"] --> E3["price"] --> E4["bound"] --> E5["act or refuse"]
    end

    META["<b>RISK_CLASS_META</b><br/>———<br/>causes · interventions · recurring"]
    META -.->|"data, not code paths"| engine

    subgraph classes["five classes"]
        direction TB
        C1["<b>payment_failure</b><br/>retry · switch_rail · link<br/>value = margin"]
        C2["<b>subscription_failure</b><br/>+ pre_debit_notify · remandate<br/>value = margin × cycles"]
        C3["<b>mandate_lapsed</b><br/>remandate only — no charge<br/>can succeed, ever"]
        C4["<b>checkout_abandonment</b><br/>payment_link only<br/>no gateway fee at all"]
        C5["<b>receivable_overdue</b><br/>notify ladder → voice → human<br/>driven by days_overdue"]
    end

    classes --> META

    style META fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style C3 fill:#3f1d2e,stroke:#fb7185,color:#ffe4e6
    style C4 fill:#064e3b,stroke:#34d399,color:#d1fae5
```

Each class differs in exactly three ways, and all three were **already inputs the gate took**:

| | Differs | Consequence |
|---|---|---|
| **Which causes** | An invoice cannot decline for insufficient funds | 18 reason codes, partitioned by class |
| **Which interventions** | An abandoned cart cannot be retried — nothing was charged | 9 interventions, `incursGatewayFee` distinguishes 2 that charge |
| **Value and cost** | A subscription is worth its remaining term; a cart nudge costs 18p not ₹3.50 | `valueCycles` multiplier; fee gated on the action |

**Two invariants make that safe rather than merely tidy.**

A policy that schedules an intervention a class does not permit **fails to load** — including a
base entry inherited by a class that would not permit it. And a retry on a lapsed mandate is
refused as `illegal_intervention` *before it is priced*, because reporting it as `refuse_ev`
would suggest a better-priced version of the same action might work.

### The seven directions, and where each lives

| Direction | Mechanism | Enforced by |
|---|---|---|
| Smart retry policy | 18-code taxonomy; a class exists only if it earns a distinct intervention | `taxonomy.ts` · `policy.default.yaml` |
| Mandate retry sequencer | A charge on a mandate rail is refused unless a notice was **delivered** ≥24h earlier | `pre_debit_notice` bound |
| Failed-subscription recovery | Value multiplies by `lifetime_cycles` | `valueCycles` in `ev.ts` |
| Checkout drop-off | Four causes by funnel stage; no fee; whole cost is the message | `checkout_abandonment` class |
| B2B receivables | Five causes, five strategies; ladder climbs channel then stops | `receivable_overdue` class |
| Promise-to-pay | Open promise **blocks** the ladder; records `await_promise` | `promise` table · `promise_open` |
| Hinglish voice | NCPR override · 10:00–19:00 window · 1 call/week · ~22× SMS cost | `voice` channel · `voice_*` bounds |

---

## 7. The dual-write problem

A fired attempt spans three steps that cannot be one atomic operation, because the middle one
leaves the database.

```mermaid
sequenceDiagram
    autonumber
    participant W as worker
    participant DB as Postgres
    participant GW as gateway

    rect rgb(20, 40, 60)
    Note over W,DB: TX — reserve
    W->>DB: decision(pending) · fee hold · audit
    end

    W->>GW: attempt(key, amount, rail, context)
    Note over W,GW: ⚡ CRASH HERE is the interesting case

    rect rgb(20, 40, 60)
    Note over W,DB: TX — settle
    W->>DB: outcome · decision(settled) · audit
    end
```

After a crash the process comes back **not knowing whether the dispatch reached the gateway**.
Guessing either way is wrong: assume it did and a recoverable payment is abandoned; assume it
did not and the customer may be charged twice.

So it does not guess.

```mermaid
flowchart TD
    START(["decision stuck in 'pending'<br/>past its lease"]) --> ASK["gateway.lookup(idempotencyKey)"]
    ASK --> FOUND{"gateway has<br/>a record?"}
    FOUND -->|yes| SETTLE["settle from the gateway's record<br/><b>never re-dispatch</b>"]
    FOUND -->|no| RESEND["the dispatch never landed —<br/>re-send under the SAME key"]
    SETTLE --> AUDIT["audit: attempt.reconciled"]
    RESEND --> AUDIT

    style START fill:#422006,stroke:#fbbf24,color:#fef3c7
    style SETTLE fill:#064e3b,stroke:#34d399,color:#d1fae5
    style RESEND fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
```

**The idempotency key is derived, not random:** `sha256(txn_id | attempt_no | policy_version)`.
A restarted process recomputes the identical key, so the gateway deduplicates it and a partial
unique index refuses the duplicate row. Exactly one charge exists either way.

`FOR UPDATE SKIP LOCKED` lets several workers reconcile concurrently without two of them
claiming the same row.

**A bug worth recording.** `decision.updated_at` once defaulted to `now()` — the database's
wall clock — while every other timestamp in a simulated run is on the caller's clock, set in
June 2026. The reconciliation lease compared a 2026 cutoff against a 2025 wall clock and
matched nothing. The demonstration appeared to succeed while proving the opposite of its claim.
Migration 008 exists for that reason.

---

## 8. Data model

Nineteen tables and one derived view, across thirteen migrations. The relationships that matter:

```mermaid
erDiagram
    customer ||--o{ consent_event : "append-only ledger"
    customer ||--o{ txn : has
    customer ||--o{ promise : makes
    batch ||--|| batch_budget : "hard fee ceiling"
    batch ||--o{ txn : contains
    txn ||--|| failure_event : "raw gateway payload"
    txn ||--o{ classification : "one per method"
    txn ||--o{ decision : "INCLUDING refusals"
    txn ||--o{ promise : "at most one OPEN"
    decision ||--o| outcome : "only if fired"
    decision ||--o{ message_send : "only if sent"
    message_template ||--o{ message_send : "NOT NULL — no free text path"
    decision ||--o{ audit : "append-only"
    policy_version ||--o{ policy_proposal : "hash-stamped"
```

### Invariants the database enforces, not the code

| Invariant | Mechanism |
|---|---|
| The audit trail cannot be rewritten, deleted **or truncated** | triggers, including on `TRUNCATE` |
| A consent withdrawal cannot be un-withdrawn | append-only `consent_event`; `consent_current` is a view |
| A fired decision must carry an idempotency key; a refusal must not | `decision_fire_is_identified`, both halves |
| One idempotency key, one decision | partial unique index |
| A settled decision cannot return to pending | state-machine trigger |
| A failed attempt cannot have recovered money | `outcome_recovery_requires_success` |
| Spend cannot pass the batch ceiling | `batch_budget` CHECK + row lock |
| A template cannot be "registered" without a DLT id | `template_registered_has_dlt_id` |
| Only a charging action may name a rail | `decision_rail_only_when_charging` |
| A refusal must name its rule; a fired decision must not | `decision_refusal_names_its_rule` |
| A subscription cannot exist without its horizon | `txn_subscription_has_horizon` |
| A lapsed mandate must have **no** mandate reference | `txn_lapsed_mandate_has_no_ref` |
| At most one open promise per transaction | partial unique index |

**Why the table is called `decision` and not `attempt`.** A refusal is not an attempt. If
refusals lived in an `attempt` table they would consume `attempt_no`, and "attempt 2 of 2" would
start counting the times the engine declined to act — which is exactly backwards, since
declining is what preserves the budget. So: one row per **evaluation**, with the expected-value
arithmetic snapshotted on every one, because *"why didn't you try?"* is the question this system
exists to answer.

---

## 9. The evaluation harness

Six arms over one identical seeded population, so a difference between them is a difference in
strategy rather than in luck.

```mermaid
flowchart LR
    SEED["seed 42<br/>300 transactions<br/>5 risk classes"] --> POP["planTxns()<br/><i>one population,</i><br/><i>one book of customers</i>"]

    POP --> B0["<b>B0</b> do nothing<br/>the counterfactual"]
    POP --> B1["<b>B1</b> retry all, immediately"]
    POP --> B2["<b>B2</b> fixed-schedule dunning<br/><i>same budget, no diagnosis</i>"]
    POP --> B4["<b>B4</b> blast reminders<br/><i>untargeted messaging</i>"]
    POP --> B3["<b>B3</b> oracle<br/><i>reads ground truth</i>"]
    POP --> RC["<b>RC</b> Recovery Controller"]

    B0 & B1 & B2 & B4 & RC --> CMP["net value compared"]
    B3 --> CEIL["the CEILING"]
    CEIL --> CMP

    style B3 fill:#3f1d2e,stroke:#fb7185,color:#ffe4e6
    style RC fill:#064e3b,stroke:#34d399,color:#d1fae5
    style CEIL fill:#422006,stroke:#fbbf24,color:#fef3c7
```

**B2 is the comparison that matters.** B1 takes one attempt where RC takes up to three, so its
gap could be dismissed as volume. B2 removes that objection — same cadence, same three-attempt
budget, no diagnosis. Whatever separates them is the value of *knowing why the payment failed*.

**B4 exists because two of the five classes cannot be retried at all.** Without an untargeted
*messaging* baseline, checkout abandonment and overdue receivables would only be measurable
against doing nothing — a much easier bar than the payment classes are held to.

**B3 is a ceiling, not a strategy.** It reads the per-issuer effect no real policy can observe
and plays optimally against the true distribution. Nothing that reads the outcome before
choosing the action can ship. It is also **bounded by law rather than preference**: it ignores
the EV floor, the attempt cap and the contact ceiling because those are a merchant's choices —
but it does *not* ignore the pre-debit notification requirement, because an oracle that debits
without notice is not a ceiling but a fantasy.

### Robustness

```mermaid
flowchart TD
    TRUTH["shipped truth table"] --> PERTURB["perturb every probability<br/>independently, ±60%"]
    PERTURB --> W["500 worlds"]
    W --> RESULT["controller beat the best<br/>baseline in <b>500 of 500</b>"]

    TRUTH --> THRESH["sweep the load-bearing<br/>assumption 0.2× → 4.0×"]
    THRESH --> NOX["<b>no crossover</b> in range —<br/>and the caveat is stated:<br/>the boundary lies outside<br/>the tested range, not absent"]

    TRUTH --> HOSTILE["3 hostile worlds —<br/>one assumption systematically<br/>FALSE in each"]
    HOSTILE --> GRACE["all three degrade gracefully;<br/>success is the gate noticing<br/>and stopping, not still winning"]

    style RESULT fill:#064e3b,stroke:#34d399,color:#d1fae5
    style NOX fill:#422006,stroke:#fbbf24,color:#fef3c7
```

**The sweep once found a silent bug the tests missed.** A perfectly flat threshold curve meant
the salary-window probability could not matter — because a cumulative-clock error meant the
salary-window retry *never fired*, on any transaction, ever. ₹1.08 lakh of recoverable value, in
silence, with 141 correct-sounding refusals per batch. Recovery went from 62.4% to 91.8% of the
then-ceiling once fixed. `FAILURES.md` §3.

**The sweep runs the same code.** `planTxns`, the arms, `planNext`, the same gate, the same
bounds, the same truth model — only persistence is skipped. An integration test asserts the
in-memory sweep and the database runner fire the identical attempts and recover the identical
transactions, and that net value differs by exactly one documented quantity.

---

## 10. The improvement loop

The agent proposes; a person decides; a held-out seed judges.

```mermaid
flowchart TD
    AUDIT["audit trail from a batch"] --> AGENT["proposal agent<br/>@rc/ai"]
    AGENT --> SCHEMA{"ProposedChange<br/>schema"}

    SCHEMA -->|"fields that exist:<br/>min_gap_hours · ev_floor_paise"| CLAMP{"inside the<br/>tunable range?"}
    SCHEMA -->|"fields that DO NOT EXIST:<br/>kill_switch · quiet_hours<br/>consent · contact ceiling"| IMPOSSIBLE["<b>unrepresentable</b><br/>not rejected — absent<br/>from the output type"]

    CLAMP -->|no| REJECT["rejected before<br/>a human sees it"]
    CLAMP -->|yes| HUMAN{"human approves<br/>each change"}

    HUMAN -->|reject| STOP["recorded, not applied"]
    HUMAN -->|approve| APPLY["applyChanges()<br/>line-based, block-scoped"]
    APPLY --> HELDOUT["evaluate on a<br/><b>held-out seed</b>"]
    HELDOUT --> VERDICT["believed only if it<br/>survives unseen data"]

    style IMPOSSIBLE fill:#450a0a,stroke:#fb7185,color:#ffe4e6
    style HUMAN fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style HELDOUT fill:#064e3b,stroke:#34d399,color:#d1fae5
```

**The safety property is the schema, not the prompt.** The agent cannot propose relaxing a
safety bound because those fields are absent from the type it emits. A malformed or adversarial
proposal cannot reach them — there is nothing to reach.

**Held-out evaluation is not decoration.** One approved proposal predicted a gain and measured
a *loss* on unseen data. A change tuned on one batch that only helps that batch has learned the
noise, and that is exactly what the step exists to catch.

**`applyChanges` is line-based and block-scoped, after a real bug.** It was a regex scoped to a
reason code's block by a lazy quantifier — which held only while each code appeared once in the
file, and stopped holding when per-risk-class overrides arrived. Asking to change
`card_expired.min_gap_hours` let the match run past the end of the block and silently rewrite
the *subscription override's* value instead. `FAILURES.md` §13.

---

## 11. Runtime topology

```mermaid
flowchart TB
    subgraph docker["docker compose"]
        PG[("PostgreSQL 16<br/>:5433")]
        RD[("Redis<br/>:6380")]
    end

    subgraph cli["command-line entry points"]
        DEMO["pnpm demo<br/><i>build → reset → seed → eval → report</i>"]
        SWEEP["pnpm sweep<br/><i>500 worlds, in memory</i>"]
        ABLATE["pnpm ablate<br/><i>classifier arms, in rupees</i>"]
        PROPOSE["pnpm propose<br/><i>agent + human + held-out</i>"]
        REPORT["pnpm report<br/><i>artifacts/report.html</i>"]
        RZPCLI["pnpm razorpay<br/><i>dry-run by default</i>"]
    end

    subgraph ext["external, optional"]
        ANTH["Anthropic API<br/>claude-opus-5"]
        RZPAPI["Razorpay API<br/>TEST MODE ONLY"]
    end

    WEB["Next.js console :3100<br/>Server Components —<br/><b>no API layer</b>"]

    DEMO --> PG
    SWEEP -.->|"in memory —<br/>no database"| SWEEP
    ABLATE --> PG
    PROPOSE --> PG
    REPORT --> PG
    RZPCLI --> PG
    WEB --> PG

    ABLATE -.->|optional| ANTH
    PROPOSE -.->|optional| ANTH
    RZPCLI -.->|"--live only"| RZPAPI

    style PG fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
    style RZPAPI fill:#422006,stroke:#fbbf24,color:#fef3c7
    style WEB fill:#1e1b4b,stroke:#818cf8,color:#e0e7ff
```

**Everything works with no `.env` and no network.** `DATABASE_URL` defaults to the Compose URL;
without an Anthropic key the LLM arm skips with a clear message and the keyword arm reports on
its own; without Razorpay keys `pnpm razorpay` runs as a dry run and prints the exact JSON it
would POST.

**The console has no API layer.** Server Components query Postgres directly, so there is no
route handler to keep in sync with the page that reads it. Aggregation happens in TypeScript
rather than SQL, because `value = recovered × margin_bps` must use the identical rounding as
the gate that decided the action — Postgres bigint division truncates while `mulBps` rounds
half away from zero, and a page disagreeing with the engine by a paise per row is worse than no
page.

**Razorpay is strictly additive, and that is enforced.** Two build-failing rules: the eval,
simulator, policy and engine may not reach `@rc/razorpay` transitively, and `@rc/razorpay` may
not reach `@rc/policy`. So no network call can enter the measurement path, and the gateway
client can never decide anything.

---

## 12. Where the AI is, and is not

```mermaid
flowchart LR
    subgraph ai["MODEL — two jobs, both bounded"]
        C["<b>classify</b><br/>messy gateway text →<br/>one of 18 reason codes"]
        P["<b>propose</b><br/>audit trail →<br/>two tunable numbers"]
    end

    subgraph det["DETERMINISTIC — everything that moves money"]
        G["expected-value gate"]
        B["bounds"]
        S["schedules"]
        I["idempotency"]
        A["audit"]
    end

    C -->|"a reason code,<br/>and nothing else"| det
    P -->|"a proposal a human<br/>must approve"| det

    det --> MONEY["money moves"]

    style ai fill:#1e1b4b,stroke:#818cf8,color:#e0e7ff
    style det fill:#064e3b,stroke:#34d399,color:#d1fae5
    style MONEY fill:#0c4a6e,stroke:#22d3ee,color:#e0f2fe
```

There is **no model in the decision path**. The LLM's contribution arrives upstream as a reason
code and its influence ends there.

**Three properties bound prompt injection, and the second is a mechanism rather than an
intention:**

1. The prompt frames the failure text as untrusted data.
2. The output is a **Zod enum** over the taxonomy. A model can *index into* the codes; it cannot
   *become* an instruction. A value outside the enum is rejected, not trusted.
3. Even a successful steer is bounded by everything downstream. The worst an injection achieves
   is one wrong reason code, which then meets a published prior, the gate, a schedule and a fee
   budget. It cannot widen a bound, raise a cap, or authorise an unbudgeted attempt.

Every batch deliberately contains injection attempts (3%) and novel strings the taxonomy has
never seen (12%), so behaviour under attack is measured rather than asserted.

**Messaging is registered, not generated.** `message_send.template_id` is NOT NULL against a
DLT-registered row. There is no column in which free-form model output could be sent. The model
fills variables inside an approved body, and may draft new templates as
`draft_pending_review` for a human to register. Hinglish variants are registered templates
selected by `customer.preferred_language` — the only version of "Hinglish recovery" that could
actually go live.

---

## 13. Trust boundaries

```mermaid
flowchart TB
    subgraph untrusted["UNTRUSTED INPUT"]
        GWTEXT["gateway_description<br/><i>free text · the injection surface</i>"]
        LLMOUT["model output"]
        RZPRESP["Razorpay API response"]
        ENVV["environment variables"]
        YAML["policy + prior YAML"]
    end

    subgraph validated["VALIDATED AT THE BOUNDARY"]
        Z1["Zod enum → taxonomy"]
        Z2["Zod schema → typed response,<br/>loud failure on drift"]
        Z3["Zod schema → refuses a<br/>LIVE Razorpay key outright"]
        Z4["Zod + completeness assert<br/>at load, not mid-batch"]
    end

    subgraph enforced["ENFORCED BY THE DATABASE"]
        T1["append-only triggers"]
        T2["CHECK constraints"]
        T3["partial unique indexes"]
    end

    GWTEXT --> Z1
    LLMOUT --> Z1
    RZPRESP --> Z2
    ENVV --> Z3
    YAML --> Z4

    Z1 & Z2 & Z3 & Z4 --> enforced

    style untrusted fill:#3f1d2e,stroke:#fb7185,color:#ffe4e6
    style validated fill:#422006,stroke:#fbbf24,color:#fef3c7
    style enforced fill:#064e3b,stroke:#34d399,color:#d1fae5
```

| Surface | Control |
|---|---|
| SQL injection | Kysely parameterises everything. No string-built SQL exists. |
| Prompt injection | Output is an enum, not a string. Bounded downstream regardless. |
| Money precision | `Paise` is a branded `bigint` with no `number` constructor. |
| Secrets | `prompt_hash` is stored, never the prompt. No key is interpolated into a row or a message. |
| Live payments | A `rzp_live_` key **fails validation**. Unrepresentable, not discouraged. |
| Audit tampering | Postgres triggers, `TRUNCATE` included. |
| Rogue policy change | Unsafe fields absent from the proposal type. |
| Runaway model spend | A call and cost ceiling checked **before** each call. Breach halts the batch and writes an audit row as `actor = 'cost_ceiling'`. |
| Unauthorised policy approval | `--approve` and `--reject` require `OPERATOR_TOKEN`, compared in constant time. The published placeholder is refused by name. |

**On the last two.** Both were documented in `.env.example` and enforced nowhere — read by
zero lines of code. That is worse than an absent control, because a claimed one that does not
exist gives a reader reason to doubt the ones that do. They are now real, tested, and the
ceiling's audit row required widening the `audit.actor` vocabulary by one member, since a
budget is genuinely not the policy engine, the worker, or a human.

**What the operator gate is not:** identity, non-repudiation, or per-operator access control.
A shared secret establishes that whoever ran the command held the secret. Real deployment
wants SSO and per-operator keys.

---

## Reading order, for a reviewer with ten minutes

1. **§3 The Chinese wall** — why any number here means anything
2. **§5 The gate and the bounds** — the product, and the ordering argument
3. **§9 The evaluation harness** — B2, and the ceiling
4. [`FAILURES.md`](FAILURES.md) — nineteen bugs, five of which inflated our own results
5. `pnpm demo` — three minutes, end to end, no configuration

---

*Diagrams render on GitHub. The package graph in §2 is the same graph
`pnpm lint:boundaries` walks; every enum value and constraint name above is taken from the
source.*
