# Wapsi — Implementation Plan

> Track 03 · Razorpay AI Buildathon 2026
> Companion to `Recovery-Controller-Track03-Build-Brief-v2.docx` (the *what* and *why*).
> This document is the *how*.

---

## 1. Architecture in one screen

```
                            ┌───────────────────────────────┐
                            │  apps/web  (Next.js 15 RSC)   │
                            │  reads Postgres directly      │
                            │  server actions for the 3     │
                            │  writes a human makes         │
                            └───────────────┬───────────────┘
                                            │
  ┌─────────────────────────────────────────┴──────────────────────────────────┐
  │                              PostgreSQL 16                                  │
  │  txn · failure_event · classification · attempt · outcome · audit(append)   │
  │  consent_event · message_template · message_send · policy_version           │
  │  policy_proposal · batch · batch_budget · llm_call                          │
  └─────────────────────────────────────────┬──────────────────────────────────┘
                                            │
        ┌───────────────────────────────────┴────────────────────────────┐
        │                     apps/worker (BullMQ)                        │
        │  claim FOR UPDATE SKIP LOCKED → idempotency key → act → audit   │
        └───────────────────────────────────┬────────────────────────────┘
                                            │
   ┌──────────────┬──────────────┬──────────┴───────┬──────────────┬───────────┐
   │ @rc/core     │ @rc/policy   │ @rc/simulator    │ @rc/ai       │ @rc/eval  │
   │ money, ids   │ EV gate      │ gateway sim      │ classifier   │ 5 arms    │
   │ taxonomy     │ bounds check │ truth priors     │ proposer     │ sweep     │
   │ zod schemas  │ published    │                  │ renderer     │ hostile   │
   │              │ priors       │                  │              │ report    │
   └──────────────┴──────┬───────┴──────────┬───────┴──────────────┴───────────┘
                         │                  │
                         └──── NEVER ───────┘        ← enforced by dependency-cruiser
                            (the Chinese wall)          CI fails on violation
```

**No API layer.** The web app is read-mostly; React Server Components query Postgres
directly. The three human writes (approve proposal, reject proposal, flip kill switch)
are Server Actions. This removes an entire tier — fewer lines, fewer bugs, nothing to
keep in sync.

---

## 2. Package boundaries and why each exists

| Package | Owns | Depends on | Must never import |
|---|---|---|---|
| `@rc/core` | `Paise`, branded ids, taxonomy, shared Zod schemas, `Result` | nothing | anything |
| `@rc/db` | Kysely schema types, migrations, connection, transaction helper | `core` | `policy`, `simulator`, `ai` |
| `@rc/policy` | EV gate, bounds check, policy loader, **published priors** | `core` | **`@rc/simulator`** |
| `@rc/simulator` | Gateway simulator, **truth priors**, batch seed generator | `core` | **`@rc/policy`** |
| `@rc/ai` | Anthropic client, classifier, proposer, template renderer | `core`, `db` | `simulator` |
| `@rc/eval` | Five arms, sweep, hostile worlds, ablation, report | all | — |
| `apps/worker` | BullMQ processors, claim loop, reconciliation | all but `eval` | — |
| `apps/web` | UI | `core`, `db` | `simulator` |

### The Chinese wall is a build failure, not a promise

`.dependency-cruiser.cjs` declares `policy → simulator` and `simulator → policy`
forbidden in both directions. `pnpm lint:boundaries` runs in CI and in the
pre-commit hook. This is the single most important structural fact in the repo, and
it is worth one slide in the pitch: *"the wall is not a convention I maintained, it
is a check that fails the build."*

`@rc/eval` is the only package permitted to see both, because measuring the gap
between what the policy believes and what is true is precisely its job.

---

## 3. Tech stack — decisions and reasons

| Layer | Choice | Reason | Rejected |
|---|---|---|---|
| Runtime | Node 22, ESM, TypeScript 5.7 `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | Strictest practical config. No `any` in the money path, enforced by lint | — |
| Monorepo | pnpm workspaces + TS project references | Enough. Real package boundaries, incremental builds | Turborepo (nothing to cache at this size), Nx (ceremony) |
| DB | PostgreSQL 16 | Ledger workload: multi-row atomicity, FK integrity, `FOR UPDATE SKIP LOCKED`, trigger-enforced immutability | MongoDB — no transactional story worth having here |
| DB access | **Kysely** | Type-safe SQL without codegen daemon. `SKIP LOCKED`, CTEs and window functions are first-class, not escape hatches | Prisma — fights raw SQL, and `SKIP LOCKED` is exactly the SQL you need. Drizzle — fine, but Kysely's types are stronger |
| Migrations | Plain SQL, forward-only, numbered | Reviewable. A trigger and a check constraint are the product here, not an implementation detail | ORM-generated migrations |
| Queue | BullMQ + Redis 7 | Delayed jobs and backoff map 1:1 onto retry sequencing. Repeatable jobs for the claim loop | Kafka (theatre at this scale), pg-boss (fine, but BullMQ's delay semantics are cleaner) |
| Validation | Zod at every boundary | LLM output, policy YAML, env, server action input. One schema, inferred types | — |
| LLM | `@anthropic-ai/sdk` direct, `claude-sonnet-5` for classify/render, `claude-opus-5` for propose | An orchestration framework near a money path signals reaching for a tool before understanding the problem | LangGraph, CrewAI, AutoGen |
| LLM telemetry | `llm_call` table fed from SDK `usage` | ~30 lines, zero containers, and the cost model needs it in the DB anyway | Langfuse — a whole service for what a table does |
| UI | Next.js 15 App Router, RSC, Tailwind v4, shadcn/ui, Recharts | Server Components read Postgres directly — no API tier. shadcn gives production-grade polish with near-zero design time | Fastify + HTMX (uglier for the same effort), SPA + REST (a whole tier of nothing) |
| Testing | Vitest + fast-check + Testcontainers | Property tests on money and bounds; real Postgres for the trigger and `SKIP LOCKED` tests | Mocked DB — would not catch the two bugs that matter |
| Logging | pino, structured, `trace_id` per attempt, redact list | Every log line joins to an audit row | — |
| Packaging | Docker Compose, multi-stage images, non-root | `up` / `seed` / `eval`. Judges must not fight setup | — |

### Model selection, stated

- `claude-sonnet-5` — classification and template rendering. High volume, latency
  matters, task is well-specified.
- `claude-opus-5` — policy proposal. Low volume (once per batch), reasoning depth
  matters, and it reads a large audit trail.
- Prompt caching on the taxonomy block, which is identical across every
  classification call in a batch.

---

## 4. Data model

### 4.1 Tables

| Table | Purpose | Notable constraints |
|---|---|---|
| `customer` | Synthetic merchant customers | — |
| `consent_event` | Append-only consent ledger | Trigger blocks UPDATE/DELETE. Current state via `consent_current` view |
| `batch` | One eval run of one arm in one world | `(seed, arm, world)` unique |
| `batch_budget` | Fee budget for a batch | The row locked when debiting — this is invariant **I3** |
| `txn` | A failed payment | `amount_paise BIGINT CHECK > 0`, `margin_bps CHECK 0..10000` |
| `failure_event` | Raw gateway payload, verbatim | Original free text preserved for the ablation set |
| `reason_code` | Taxonomy, **as data** | Open-world proposals insert rows here |
| `classification` | Label + confidence + cost | `confidence_bps INT`, method, model, prompt hash |
| `attempt` | One action **or refusal** | `idempotency_key UNIQUE`, `(txn_id, attempt_no)` unique, EV snapshot columns |
| `outcome` | Result of a fired attempt | 1:1 with attempt |
| `message_template` | DLT-registered templates | `status` gates sending |
| `message_send` | Simulated delivery | FK to template — free text cannot be sent |
| `audit` | Every action and every refusal | **Trigger blocks UPDATE/DELETE** |
| `policy_version` | Full YAML snapshot + hash | Immutable once approved |
| `policy_proposal` | Agent diffs | Status, rationale, evidence, human decision |
| `llm_call` | Token / cost / latency ledger | — |

### 4.2 No floating point anywhere in the money path

Stronger than the brief's claim, and worth saying on the architecture slide:

- Amounts: `BIGINT` paise, wrapped in a branded `Paise` type. Cannot be constructed
  from a `number`.
- Margins: integer basis points.
- **Probabilities: integer basis points.** This is the part nobody does. It means
  the EV computation is pure integer arithmetic end to end:

  ```
  ev = mulBps(mulBps(amount_paise, margin_bps), p_bps) − cost_paise
  ```

  There is no `number` in that expression. LLM confidence arrives as a float and is
  converted to bps at the validation boundary — and confidence is a *routing*
  decision, never a money one.

### 4.3 Derived, not duplicated

Contact counts, attempt counts and recovery totals are **derived by query**, not
maintained as counters. One source of truth, no drift, no reconciliation job. The
only maintained counter is `batch_budget.fee_spent_paise`, because it must be
locked and debited atomically inside the same transaction as the attempt write.

---

## 5. Build order

Ordered so a defensible number exists on **day 5**, and every day after increases
credibility rather than scope.

### Milestone 0 — Foundation `day 1`
- Monorepo, strict TS, dependency-cruiser boundaries, Compose, `.env.example`
- `@rc/core`: `Paise`, branded ids, taxonomy, `Result`
- `@rc/db`: full schema, append-only triggers, Kysely types

**Done when:** `pnpm lint:boundaries` passes, and a test proves the audit trigger
rejects an `UPDATE`.

### Milestone 1 — The two walled halves `day 2`
- `@rc/policy`: `priors.published.yaml` + loader
- `@rc/simulator`: `priors.truth.yaml` + seeded gateway + batch generator (300 txns)

**Done when:** `pnpm lint:boundaries` fails if you add the forbidden import, and
`pnpm seed` produces 300 transactions with a stable hash for a given seed.

### Milestone 2 — The gates `day 3` · **SCOPE FREEZE**
- `evGate()` and `boundsCheck()` as pure functions returning a discriminated union
- fast-check property tests: sums tie, caps hold, quiet hours hold, consent holds

**Done when:** every property test passes, and both functions have zero I/O.

### Milestone 3 — First money `day 4`
- BullMQ worker, claim loop with `SKIP LOCKED`
- `insufficient_funds` end to end; idempotency key + `PENDING` reconciliation

**Done when:** two workers over one batch produce exactly one attempt per key,
proven by a Testcontainers test.

### Milestone 4 — **A NUMBER EXISTS** `day 5`
- `@rc/eval`: arms RC, B0, B1. Net value to stdout.

**Done when:** `pnpm eval` prints a net-value comparison. Everything after this
point increases credibility, not scope.

### Milestone 5 — Depth `days 6–9`
Full 9-code taxonomy · policy YAML + Zod + version stamping · LLM classifier ·
hand-labelled messy-string set + keyword baseline (ablation runnable)

### Milestone 6 — Compliance and evidence `days 10–12`
Consent ledger · DLT template table · simulated inbox · Hinglish variants ·
B2 fixed-schedule · **B3 oracle** · sensitivity sweep

### Milestone 7 — The differentiators `days 13–16`
Hostile worlds · calibration report · policy-proposal agent + whitelist schema +
approval flow · v3→v4→v5 on a held-out seed · one proposal prepared for rejection
on stage

### Milestone 8 — Surface `days 17–18`
Next.js dashboard · generated `report.html` with the value-frontier chart ·
crash-resume verified by `docker kill` · clean-clone test · README

### Milestone 9 — **STOP BUILDING** `days 19–21`
Pitch script, slides, recording, five rehearsals, three recordings.

---

## 6. UI plan

Five views. Read-mostly, Server Components, no client state library.

| Route | Shows | Why it earns its place |
|---|---|---|
| `/` **Run** | Live batch timeline, per-reason funnel, running net value, kill switch | The demo spine. One live control: the kill switch |
| `/audit` | Append-only trail, filterable by trace id / txn / event type. Every row shows actor, policy version, rationale | Answers *"show me the audit trail"* by scrolling, not by claiming |
| `/exceptions` | The refusal queue. Each row carries its EV arithmetic — `p`, value, cost, net — and the bound that blocked it | The credibility segment. A refusal that can explain itself in rupees |
| `/policy` | Current YAML, version history, proposal queue with approve/reject | Where the self-improvement loop is visible, including the rejection |
| `/inbox` | Simulated customer inbox: rendered message, template id, and **the sends that were blocked, with the reason** | Closes the loop visually. Where the Hinglish work lands |

**Design direction:** dense, monospace-numeric, dark-first, no decorative chrome.
It should read like an internal ops console at a payments company, because that is
what it is. Tabular numbers, right-aligned currency, `tabular-nums`, generous
whitespace between groups and tight within them. Every currency figure carries its
unit. No animation except state transitions on the run timeline.

---

## 7. Security

Not decorative — each item maps to a real surface in this system.

| Surface | Risk | Control |
|---|---|---|
| **Gateway error strings → LLM prompt** | **Prompt injection.** `gateway_description` is untrusted free text flowing into a model call. A crafted string could try to force a misclassification, and a misclassification spends money | Untrusted text is delimited and never interpolated into instructions. Output is constrained to an enum via Zod — a classification that is not a known `reason_code` is rejected, not trusted. The classifier's output can only ever *index into* the taxonomy; it can never *become* an instruction. Injection attempts are logged and quarantined |
| LLM output → any code path | Malformed or hostile JSON | Zod parse at the boundary; parse failure routes to the exception queue. No `JSON.parse` result reaches business logic untyped |
| Policy proposals | An agent widening its own bounds | `global.*` is **absent from the proposal schema**. A proposal touching it fails validation. Tunables are range-clamped. Human approval recorded with actor and diff hash |
| Audit tamper | Silent history rewrite | `BEFORE UPDATE OR DELETE` trigger raising an exception. The app role has no `TRUNCATE` grant |
| SQL | Injection | Kysely parameterises everything. Zero string-concatenated SQL; lint rule bans `sql.raw` outside migrations |
| Secrets | Leakage | Env only, `.env` git-ignored, `.env.example` checked in, Zod-validated at boot with fail-fast. pino `redact` on `authorization`, `apiKey`, `raw.customer` |
| Server Actions | Unauthenticated privileged writes | Kill switch and proposal decisions require an operator token; every invocation writes an audit row with the actor |
| Container | Escalation | Multi-stage build, non-root user, no dev dependencies in the runtime image, pinned base digests |
| PII | Real customer data | **There is none.** All data is synthetic and generated from a seed. Stated in the README, and the generator is the only source of customer rows |
| Rate / cost | Runaway model spend | Per-batch LLM call cap and cost cap in policy; breach halts the batch and audits it |

---

## 8. Testing strategy

| Level | Tool | Covers |
|---|---|---|
| Property | fast-check | Money sums tie · attempt caps hold for any generated policy · contact ceiling holds for any batch · no send in quiet hours at any offset · no send against opt-out · kill switch produces zero subsequent attempts |
| Integration | Vitest + Testcontainers | Audit trigger rejects UPDATE and DELETE · `SKIP LOCKED` gives exactly-one-per-key under N concurrent workers · `PENDING` reconciliation does not re-fire |
| Boundary | dependency-cruiser | The Chinese wall, in CI |
| Contract | Zod round-trip | Policy YAML, LLM outputs, proposal schema |
| Determinism | Vitest snapshot | Same seed ⇒ byte-identical `metrics.json` |

**Not** aiming for a coverage number. Aiming for: every invariant in §7 of the brief
has a test that would fail if it broke.

---

## 9. Definition of done, per the brief's bar

Ship gate — all must be true:

- [ ] `git clone` → `docker compose up` → `pnpm seed` → `pnpm eval` on a clean machine
- [ ] `pnpm eval --seed 99` produces different data and materially similar conclusions
- [ ] `metrics.json` contains all five arms including the oracle ceiling
- [ ] `pnpm lint:boundaries` green — the wall holds
- [ ] Every property test in §8 green
- [ ] README opens with the results table, above any prose
- [ ] Full exception list published unabridged
- [ ] Every prior cell in `priors.published.yaml` carries a citation or is marked `ASSUMED`
