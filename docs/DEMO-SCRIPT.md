# 5-minute demo script

Recovery Controller · Track 03 — AI Revenue Recovery

**Read this on a second screen while you record.** Narration is word-for-word on the left,
what the viewer sees on the right. Timings are cumulative.

---

## Before you press record

Run these and **leave them ready**. Nothing in the video should wait on a build.

```bash
docker compose up -d
pnpm build                       # get the compile out of the way
pnpm run db:reset && pnpm seed   # DB seeded, eval NOT yet run
pnpm report                      # so artifacts/report.html exists
```

Then set up:

| | |
|---|---|
| **Terminal 1** | large font (18pt+), dark theme, at the repo root, cleared |
| **Terminal 2** | second tab, also at the repo root |
| **Browser tab 1** | `http://localhost:3100` — start `pnpm web` in a third terminal first |
| **Browser tab 2** | `artifacts/report.html` open from `file://` |
| **Phone** | on screen or held up, ready for the Razorpay link |
| **Editor** | `packages/policy/src/ev.ts` open, cursor on line 1 |

**Do NOT run `pnpm web:build` at any point.** It breaks the running dev server.

One rehearsal before the real take. The 58-second `eval` is the only thing you have to talk
over, and it should feel deliberate rather than like filling time.

---

## 0:00 – 0:20 · The hook

> **Screen:** black, then just the text `₹3.50` filling the frame.

**"Three rupees fifty. That's what it costs to retry a failed card payment in India —
whether the retry works or not.**

**So retry a hundred and recover five, and you may have spent more than you got back. Almost
no recovery system can tell you which hundred were worth trying."**

> **Screen:** cut to your face or the repo. Title card: *Recovery Controller*.

---

## 0:20 – 0:50 · The claim, and start the run

**"I built an agent for Track 03. Its main achievement is refusing to act."**

> **Action:** Terminal 1 — type and run:
> ```bash
> pnpm eval
> ```
> Let it start scrolling. **Do not wait for it.** Keep talking.

**"That's six strategies over the same three hundred stuck transactions — so any
difference between them is strategy, not luck.**

**While it runs, the problem."**

---

## 0:50 – 1:30 · The problem, precisely

> **Screen:** the eval scrolling. Or cut to a simple list of the five classes.

**"A merchant leaks revenue five ways, and most tools answer all five the same: retry.**

**But an abandoned checkout has nothing to retry — nothing was ever charged. And an expired
card succeeds zero percent of the time, forever.**

**So the question isn't how to retry more. For each stuck rupee: is acting worth it? That's
arithmetic."**

> **Screen:** the formula, large:
> ```
> probability × (amount × margin)  −  cost  ≥  floor
> ```

**"Chance of success, times the margin at stake, minus the cost of trying. Every action
clears that before it happens."**

---

## 1:30 – 2:20 · The numbers

> **Action:** the eval has finished. Scroll to the arms table.

**"Here's the result."**

> **Screen:** point at the rows as you say them.

**"Fixed-schedule dunning — what most tools ship — fired four hundred and thirty-five
attempts, recovered fifty.**

**Mine fired two hundred ninety, recovered seventy-six. Fewer attempts, more recoveries,
sixty-eight percent less spent.**

**But this is the column that matters."**

> **Screen:** the negative-EV table.

**"Three hundred forty-five of dunning's four hundred thirty-five attempts had negative
expected value — priced on its own evidence, not hindsight. Destroying value four times in
five.**

**Mine did that zero times. Not tuning — the gate refuses them by construction."**

---

## 2:20 – 3:00 · The part nobody else will have

> **Action:** switch to the browser — `http://localhost:3100/exceptions`

**"Every other submission will show you what it recovered. This shows you what it refused."**

> **Screen:** scroll the exception queue slowly.

**"Two hundred and twenty-four refusals. Each records the probability, the amount at stake,
the cost, and the net. Ask this system *why didn't you try?* and it answers in rupees.**

**And it prices its own safety rules."**

> **Action:** back to Terminal 1 — scroll to the guardrail table.

**"My compliance rules cost me one lakh ninety-three thousand rupees of expected recovery.
Eighty-eight percent of that is consent — customers who never opted in.**

**That's not a gap I'm hiding. That's the price of being shippable, and I can hand you the
number."**

---

## 3:00 – 3:50 · Why you should believe any of it

**"Now — I wrote the simulator these numbers come from. So why should you believe them?"**

> **Screen:** two files side by side, or the diagram from ARCHITECTURE.md §3.

**"Because the policy engine cannot read it.**

**What the system believes about success rates, and what the world actually does, are two
separately written files with deliberately different numbers. If the policy could read the
answers, 'my strategy won' would be circular.**

**Let me try to cheat."**

> **Action:** in the editor, add to the top of `packages/policy/src/ev.ts`:
> ```ts
> import { loadTruthModel } from '@rc/simulator';
> ```
> Save. Then Terminal 2:
> ```bash
> pnpm lint:boundaries
> ```
> **This takes 3 seconds and fails.**

**"The build fails. There are two independent checks, because the first version silently
passed with a real violation in the file."**

> **Action:** delete the line. Save.

**"And the comparison reruns in five hundred perturbed worlds, every probability moved by up
to sixty percent. It wins in five hundred out of five hundred."**

---

## 3:50 – 4:25 · It's not just a simulation

> **Action:** Terminal 2:
> ```bash
> pnpm razorpay --limit 3 --live
> ```

**"And these decisions aren't theoretical. This takes the payment links my engine decided
were worth sending, and creates them as real Razorpay Payment Links."**

> **Screen:** real `rzp.io` links appear. **Open one on your phone, on camera.**

**"Live, in Razorpay test mode."**

> **Action:** run the exact same command again.

**"Run it again — Razorpay refuses. Zero created, three already existed. The reference
carries my engine's idempotency key, so Razorpay itself won't create a second demand for the
same money.**

**My crash-safety guarantee, enforced by their server."**

---

## 4:25 – 5:00 · Close

> **Screen:** the per-class table, then `FAILURES.md`.

**"All seven directions in the brief are built — one engine across five risk classes, not
five systems.**

**The honest number is sixty-two and a half percent of what a perfect-knowledge oracle could
achieve. I'm not claiming a hundred, because I measured against a ceiling.**

**And this file lists nineteen bugs I found. Five of them were inflating my own results."**

> **Screen:** hold on FAILURES.md for two seconds.

**"Any recovery system can tell you what it recovered.**

**This one tells you what it refused, what that cost, and how wrong it might be.**

**Thank you."**

> **Screen:** end card — repo URL.

---

## Length

**609 words of narration — 4:31 at a measured pace, 4:12 if you're brisk.** That leaves 29
seconds of air inside a five-minute limit, which is what the visual beats need: the pause on
`₹3.50`, the phone, the two seconds on FAILURES.md.

It was 732 words on the first draft — 5:25, which would have meant rushing the numbers. The
numbers are the point, so the prose lost instead.

**If you still overrun**, cut in this order:

1. *"Chance of success, times the margin at stake…"* at 1:20 — the formula is on screen
2. The 500-worlds sentence at 3:45
3. *"While it runs, the problem."* at 0:45

**Never cut:** the negative-EV comparison (1:50), the exception queue (2:20), or the wall
break (3:20). Those three are the whole submission.

---

## The four moments that win it

| Moment | Why it lands |
|---|---|
| **"Its main achievement is refusing to act"** | Counter-intuitive, memorable, and true. Nobody else will say this. |
| **"345 of 435 attempts destroyed value. Mine: zero."** | One number, brutal comparison, priced on evidence not hindsight |
| **Breaking the wall live** | 3 seconds. Turns an architecture claim into a demonstrated fact. |
| **"Five of those bugs were inflating my own results"** | Nobody volunteers this. It makes every other number credible. |

---

## Recording notes

- **Speak 10% slower than feels natural.** Numbers need air around them.
- **Cursor stops moving when you're talking about something.** Wandering cursors read as
  nervous.
- Terminal font **18pt minimum**. A judge may watch on a laptop.
- If a command fails on camera, **say what happened and move on**. Do not restart the take —
  composure reads better than a clean run.
- Record the audio in one pass if you can. Cutting between sentences is audible.
