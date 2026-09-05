# Research and regulatory grounding

The external sources behind Wapsi's design, and — just as important — a plain statement of
which parts of this system are **not** sourced.

---

## How to read this document

This project makes a sharp distinction between two kinds of number, and the distinction is
mechanised rather than promised.

| | What it is | How it is treated |
|---|---|---|
| **A rule** | A statutory or contractual constraint. *A recurring debit needs a notice delivered 24 hours earlier.* | Implemented as a hard refusal. Not tunable. The agent has no field in which to propose relaxing it. |
| **A probability** | A belief about how often an intervention works. *A retry into the salary window succeeds 45% of the time.* | Carried in `priors.published.yaml`, perturbed in the sensitivity sweep, and **every one of the 39 rows is currently marked `ASSUMED`.** |

The rules below are sourced. **The probabilities are not**, and §6 says so at length rather than
burying it. Sourcing the rules while inventing the probabilities is the honest configuration
for a project graded on a simulator: the legal envelope is real and checkable, the success
rates are a model whose sensitivity is measured.

---

## 1 · Statutory grounding — the rules the engine cannot be talked out of

### 1.1 · RBI e-mandate framework — the 24-hour pre-debit notification

- **Source:** RBI circular `DPSS.CO.PD.No.447/02.14.003/2019-20` (21 August 2019), *Processing
  of e-mandate on cards for recurring transactions*, since consolidated into the
  **Digital Payments – E-mandate Framework, 2026**.
  · [RBI circular summary](https://resources.probe42.in/regulatory-updates/rbi-circulars/rbi-circular-processing-of-mandate/)
  · [Consolidated 2026 framework](https://taxguru.in/rbi/rbi-issues-consolidated-directions-digital-payments-e-mandate-framework-2026.html)
  · [24-hour requirement reporting](https://www.tribuneindia.com/news/business/rbi-tightens-auto-debit-rules-24-hour-prior-alert-now-mandatory-for-recurring-payments/)

- **What it requires:** the issuer must send a pre-debit notification to the customer at least
  **24 hours before** a recurring charge is debited, giving them time to review or dispute it.

- **What it grounds:** the `pre_debit_notice` bound in
  [`bounds.ts`](packages/policy/src/bounds.ts). A charge on a mandate rail is refused unless a
  notification was **delivered** ≥24h earlier.

- **The design decision it forced, and this is the part that matters.** The check reads
  `message_send` — the record of what actually went out — rather than the decision that
  *planned* a notice. A notice suppressed by quiet hours never reached the customer, so the
  debit is still unlawful. Reading intent instead of delivery would have produced a system that
  believed itself compliant while breaking the rule. It also has a knock-on effect the engine
  had to absorb: sub-24-hour backoff schedules become unavailable on mandate rails entirely.

### 1.2 · TRAI TCCCPR 2018 — DLT registration and the NCPR/DND register

- **Source:** Telecom Commercial Communications Customer Preference Regulations, 2018 (TRAI),
  and the DLT framework built under it.
  · [TCCCPR / DLT overview](https://www.telerivet.com/blog/india-sms-compliance-trai-dlt-registration-and-tcccpr-guide)
  · [TRAI direction on misuse of headers and content templates](https://www.argus-p.com/updates/updates/trai-issues-direction-to-curb-the-misuse-of-headers-and-content-templates/)

- **What it requires:** commercial SMS in India needs **three-layer registration** — entity,
  header (sender ID), and *content template*. Templates are scrubbed at the network in real
  time and a message whose content does not match an approved template exactly is blocked.
  Separately, the **NCPR** (National Customer Preference Register, India's DND system) records
  a subscriber's standing preference with the regulator.

- **What it grounds:**
  - `no_template` — every send must reference a registered `message_template` row carrying a
    DLT registration id. A database constraint refuses to mark a template registered without
    one.
  - **The model fills variables inside an approved body and composes nothing.** This is not a
    stylistic preference about LLM safety; free-composed marketing text would fail template
    scrubbing at the network and never be delivered.
  - `ncpr_registry` — a voice-specific bound that **overrides merchant-level consent**. A
    standing instruction to the regulator outranks a checkbox on a merchant's form, so it is
    checked separately from `consent` rather than folded into it.

### 1.3 · RBI recovery-agent conduct — the calling window

- **Source:** RBI circular of **12 August 2022** on the conduct of recovery agents, which
  directs that lenders and their agents shall not contact a borrower **before 08:00 or after
  19:00**, and which explicitly includes SMS and digital messages.
  · [Reporting on the circular](https://www.business-standard.com/amp/article/finance/rbi-directs-loan-recovery-agents-not-to-intimidate-borrowers-no-calling-before-8am-after-7pm-122081201144_1.html)
  · [Fair Practices Code context](https://www.yuverse.ai/resources/posts/what-rbis-guidelines-on-recovery-agents-mean-for-your-collections-team)

- **What it grounds:** the `voice_window` bound. The engine's configured window is
  **10:00–19:00 Asia/Kolkata** ([`policy.default.yaml`](packages/policy/policy.default.yaml)).

- **Stated precisely, because the difference is a choice and not a citation.** The **19:00**
  end is the regulatory bound. The **10:00** start is *stricter than required* — the regulation
  permits 08:00. Nothing forced that; it is a conservative default a merchant could widen, and
  it is recorded here as a policy decision rather than presented as compliance.

- **A related honest note.** The engine's messaging quiet hours are **21:00–09:00**, i.e.
  messaging is permitted 09:00–21:00. That is a **policy choice** consistent with ordinary
  Indian telemarketing practice, not a figure taken from a specific instrument. Where the two
  regimes disagree, voice is held to the tighter one. This project treats voice as a separate
  channel under a separate regime rather than as a louder SMS, which is why the two windows are
  configured independently at all.

---

## 2 · Payment rails and the failure vocabulary

### 2.1 · ISO 8583 response codes

- **Source:** ISO 8583, field 39 (response code). Standard values include `00` approved,
  `05` do not honour, `51` insufficient funds.
  · [ISO 8583 response codes](https://neapay.com/post/iso8583-response-codes-for-transaction-processing_100.html)
  · [ISO 8583 message structure](https://www.pxp.io/payments-glossary/iso-8583)

- **What it grounds:** the 18-code failure taxonomy in
  [`taxonomy.ts`](packages/core/src/taxonomy.ts), and the keyword classifier that is the
  ablation's control arm. Every keyword rule is derived from ISO 8583 vocabulary and real
  gateway strings — **none of it from reading the corpus it is scored against**, which is what
  makes it a fair opponent rather than a strawman. A test enforces that in both directions:
  above 30% so the comparison is not rigged, below 85% because near-perfect accuracy on a
  corpus containing a deliberately unreadable tier would prove the rules were overfitted to it.

- **The finding that justifies having a model at all.** The research is explicit that card
  networks **add proprietary codes on top of the standard**, which require network-specific
  documentation to interpret. That is precisely the gap a lookup table cannot close: a fixed
  map handles `51` and `05`, and then meets a vendor mnemonic, a bare numeric code from an
  acquirer's own range, or transliterated Hinglish free text in `gateway_description`. The
  measured consequence is in the ablation — the keyword arm **quarantines 154 of 310**
  transactions, giving up on half the book, while the model quarantines 111.

### 2.2 · Razorpay pricing — and a caveat this project owes the reader

- **Source:** Razorpay's published tariff — **2% + 18% GST** on the fee for domestic cards,
  UPI, netbanking and wallets, charged on **successful** transactions; 3% + GST for premium
  instruments and international cards.
  · [Razorpay pricing explained](https://razorpay.com/blog/razorpay-payment-gateway-pricing-explained/)
  · [MDR, TDR and platform fee guide](https://razorpay.com/blog/convenience-fee-tdr-mdr-platform-fee-amc-setup-fee-technology-fee-of-payment-gateway/)

- **What the engine models:** a **flat per-attempt** cost — card `350` paise, netbanking `200`,
  wallet `150`, UPI `80`; SMS `18`, WhatsApp `75`, email `2`, voice `400`
  ([`policy.default.yaml`](packages/policy/policy.default.yaml), which labels these
  *"merchant-specific in reality; representative here"*).

- **Where the model and the published tariff differ, stated plainly.** Razorpay's tariff is
  *ad valorem* and *success-conditional*: 2% of the transaction, charged when it succeeds. The
  engine's ₹3.50 is a *flat, per-attempt* figure. These are not the same thing, and the
  difference is material on large tickets. The ₹3.50 stands for the blended cost of **making an
  attempt** rather than for MDR alone — the acquiring and network cost of an authorisation, and
  the decline-rate penalty a merchant carries for re-presenting aggressively. Razorpay's own
  pricing guidance makes the second effect explicit: *a gateway quoting 1.9% MDR with 85%
  success can produce a higher effective cost per successful sale than one quoting 2% with 92%
  success.* Cost per attempt is a real quantity even where MDR is not charged on a failure.

- **What is unambiguous, and it carries most of the argument.** The **messaging** costs are
  incurred whether or not recovery follows. An SMS costs 18 paise on send. That is why the
  untargeted-messaging baseline spent **₹94.18 to recover 8 transactions** out of 540 messages,
  and why two of the five risk classes — checkout abandonment and overdue receivables — have no
  charge to re-present and are pure messaging economics.

- **Consequences of the fee ratio, which the policy leans on.** A payment link costs **18
  paise** against a card retry's **₹3.50** — roughly 19×. A link therefore clears the
  expected-value floor at probabilities where a retry cannot, which is why abandoned checkouts
  are worth chasing at all. Voice at ₹4.00 is ~22× an SMS, which is what makes the gate's choice
  between a message and a call a real economic decision rather than an escalation reflex.

---

## 3 · Statistical method

### 3.1 · The Wilson score interval

- **Source:** Wilson, E. B. (1927), *Probable Inference, the Law of Succession, and Statistical
  Inference*, JASA 22(158):209–212. Brown, L. D., Cai, T. T. & DasGupta, A. (2001), *Interval
  Estimation for a Binomial Proportion*, **Statistical Science** 16(2):101–133.
  · [Brown, Cai & DasGupta](http://www-stat.wharton.upenn.edu/~tcai/paper/html/Binomial-StatSci.html)
  · [Properties of the Wilson interval](https://arxiv.org/pdf/2109.12464)

- **Why this interval and not the normal approximation.** Brown, Cai and DasGupta's review
  recommends the Wilson interval specifically **for small n**, where the normal approximation
  suffers overshoot and zero-width intervals. Degradation detection is exactly that regime: a
  cohort may have three authorisation attempts in a 30-minute window.

- **What it grounds:** [`stats.ts`](packages/core/src/stats.ts), and the `lower bound` column
  on the `/detect` page. A cohort is reported only if the **lower bound** of its failure-rate
  interval clears the contemporaneous peer baseline — which is why a three-attempt cohort
  cannot raise an alert no matter how badly it is doing. On the shipped run this yields 2
  cohorts reported of 25 watched, at 100% recall and 100% precision against episodes the
  detector cannot see.

- **The one place floating point is permitted.** Every rupee in this system is integer paise
  behind a branded type with no `number` constructor. The Wilson bound is the documented
  exception, on the grounds that *a probability is not money*.

---

## 4 · Market context

### 4.1 · Cart abandonment

- **Source:** Baymard Institute, aggregating 50 studies to an average documented cart
  abandonment rate of **70.22%**, with mobile at 80.02% against desktop at 66.41%.
  · [Baymard cart abandonment statistics](https://baymard.com/lists/cart-abandonment-rate)

- **What it grounds:** the decision to treat `checkout_abandonment` as a first-class risk class
  rather than a marketing concern, and — more specifically — to split it by **funnel stage**
  rather than treat it as one population. Someone who left at the cart was browsing; someone
  who reached the OTP screen had their card out. The engine models four separate causes
  (`abandoned_at_cart`, `abandoned_at_address`, `abandoned_at_payment`, `abandoned_at_otp`)
  because their recovery economics differ by more than 5×.

- **What it does not ground.** Baymard measures *abandonment*, not *recovery*. The probability
  that a given nudge recovers a given abandoned cart is not in this source and is not in any
  public source we found — see §6.

---

## 5 · Where each source lands in the code

| Source | Design decision | Enforced in |
|---|---|---|
| RBI e-mandate framework, 24h notice | A mandate debit refuses without a **delivered** notice | `pre_debit_notice` · [`bounds.ts`](packages/policy/src/bounds.ts) |
| TRAI TCCCPR 2018 — DLT templates | The model fills variables; it never composes a body | `no_template` · `message_template.dlt_template_id` |
| TRAI TCCCPR 2018 — NCPR/DND | Registry overrides merchant consent, voice only | `ncpr_registry` · [`bounds.ts`](packages/policy/src/bounds.ts) |
| RBI recovery-agent circular, Aug 2022 | Calls end at 19:00; start held stricter at 10:00 | `voice_window` · [`policy.default.yaml`](packages/policy/policy.default.yaml) |
| ISO 8583 field 39 + proprietary codes | An 18-code taxonomy, and a keyword arm built from the standard | [`taxonomy.ts`](packages/core/src/taxonomy.ts) · `pnpm ablate` |
| Razorpay 2% + GST tariff | A per-attempt cost model, so net is net | `costs` · [`ev.ts`](packages/policy/src/ev.ts) |
| Wilson (1927); Brown, Cai & DasGupta (2001) | Small-n cohorts cannot raise an alert | [`stats.ts`](packages/core/src/stats.ts) |
| Baymard, 70.22% abandonment | Four funnel-stage causes, not one class | `RISK_CLASS_META` · [`risk.ts`](packages/core/src/risk.ts) |

---

## 6 · What is **not** sourced

**All 39 probability rows in
[`priors.published.yaml`](packages/policy/priors.published.yaml) are marked `ASSUMED`.** Not
one carries a citation. The file's own header says so:

> Rows currently marked `ASSUMED` with a `TODO(cite)` are research debt. The MECHANISM that
> widens their band is real and tested; the citations are a separate task. **Nothing here is
> presented as sourced when it is not.**

This is the honest state of the project and it is stated here rather than left to be
discovered. Three things follow.

**The schema was built to make this visible, not to hide it.** Every row must carry either a
`{ ref, retrieved }` pair or the literal `ASSUMED` plus an `assumption` field explaining the
reasoning. There is no third option and no default. A row cannot quietly omit its provenance.

**Being unsourced costs something automatically.** The sensitivity sweep perturbs cited figures
by **±40%** and assumed figures by **±60%**. Because every row is currently assumed, every row
gets the wider band — so the headline result is already being reported under the harsher of the
two treatments. Honesty is mechanised here rather than promised: an author who added a fake
citation would *narrow* their own error bars, which is the opposite of the incentive most
research documents create.

**The sweep is the answer to "so how much does this matter?"** Across 500 worlds with every
ground-truth probability moved by up to ±60%, the controller beats the best baseline in
**500 of 500**. Three hostile worlds each falsify one structural assumption outright. That does
not turn an assumed figure into a sourced one. It bounds how wrong the figures can be before
the conclusion changes, which is the most that can honestly be claimed.

**What would actually settle it.** Nothing in this document, and nothing in the sweep. Only a
live gateway. The priors describe recovery rates by cause and timing at a granularity no
merchant publishes and no vendor discloses — which is *why* they are assumed. A deployment
behind a real acquirer would replace all 39 rows within a single billing cycle, and the
evaluation harness is already built to grade the old policy against the new data.

---

## 7 · Deliberately not modelled

Recorded so that their absence reads as a decision rather than an oversight.

- **MDR and GST are not itemised.** Value is contribution margin, which is the correct unit for
  a decision gate and is already net of the cost of serving a rupee. It does not break out the
  2% + 18% GST a payments operator thinks in. A merchant-facing product would.
- **T+2 settlement timing is not modelled.** Recovery is treated as recovered at authorisation.
- **The MSMED Act 2006** — the 45-day payment ceiling and its penal-interest mechanism — is not
  implemented. `receivable_overdue` models the *process* causes of non-payment (an approver, a
  payment run, a dispute) rather than the statutory interest position. This is the largest
  single gap in the receivables class and the most obvious next piece of work.
- **NPCI UPI AutoPay retry caps** are not separately enforced. Mandate retries are governed by
  the generic attempt cap and the pre-debit notice rule instead.
- **The issuer effect is not applied to non-charging actions**, on purpose. A co-operative
  bank's flaky authorisation infrastructure is a real reason a debit fails; it has nothing to do
  with whether a customer taps a link. Applying the multiplier there would be modelling noise
  dressed as rigour.

---

<sub>Retrieved 5 September 2026. Every link above was opened and checked; where a search could
not confirm a specific detail — such as whether ISO 8583 defines `54` for an expired card versus
it being network-proprietary — the uncertainty is stated in the text rather than resolved in the
project's favour.</sub>
