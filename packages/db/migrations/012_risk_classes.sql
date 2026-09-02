-- 012_risk_classes.sql
--
-- Generalise "revenue at risk" beyond a failed payment.
--
-- The brief names seven directions across three domains — payment failures, checkout
-- abandonment, and overdue receivables. Until now the system modelled only the first, and
-- `txn` literally meant "a payment that failed".
--
-- The extension is deliberately a NEW DIMENSION rather than new tables. A checkout that was
-- abandoned, a subscription cycle that failed, and an invoice that went overdue are all the
-- same shape of thing: an amount of money at risk, attached to a customer, with a cause, on
-- which a bounded and priced intervention may be attempted. That is exactly what the
-- decision engine already does — so every risk class inherits the expected-value gate, the
-- bounds, the audit trail, and the evaluation harness for free.
--
-- Two consequences worth noting:
--
--   The cost structure differs per class. A payment retry costs a gateway fee; a checkout
--   nudge costs only a message, because nothing is charged. The EV gate already takes fee
--   and message cost as separate inputs, so this needs no change to the arithmetic.
--
--   The VALUE term differs too. Recovering one subscription cycle is worth less than
--   recovering the subscription, because a lapsed subscriber stops paying every cycle after
--   it. That is handled by `lifetime_cycles` below.

-- ---------------------------------------------------------------------------
-- Risk class
-- ---------------------------------------------------------------------------

alter table txn
  add column risk_class text not null default 'payment_failure'
    check (risk_class in (
      'payment_failure',        -- a one-off payment that failed
      'subscription_failure',   -- a recurring cycle that failed; churn risk compounds
      'mandate_lapsed',         -- the authorisation itself is gone or expiring
      'checkout_abandonment',   -- the customer left before paying; nothing was charged
      'receivable_overdue'      -- a B2B invoice past its due date
    ));

comment on column txn.risk_class is
  'What kind of revenue is at risk. Every class shares the same decision engine — the '
  'differences are the cause taxonomy, the permitted interventions, and the cost and value '
  'terms fed to the expected-value gate.';

create index txn_risk_class_idx on txn (batch_id, risk_class);

-- ---------------------------------------------------------------------------
-- Subscription economics
-- ---------------------------------------------------------------------------
-- Recovering a failed subscription cycle is not worth one cycle's margin. If the recovery
-- fails the subscriber is gone, and every future cycle goes with them. Pricing a
-- subscription retry at single-cycle value systematically under-invests in exactly the
-- customers worth most — so the expected remaining cycles are recorded on the row and the
-- gate multiplies by them.
--
-- Null for everything that is not a subscription, and the CHECK ties the two facts together
-- so a subscription cannot exist without its horizon.

alter table txn
  add column lifetime_cycles integer
    check (lifetime_cycles is null or lifetime_cycles between 1 and 120);

alter table txn
  add constraint txn_subscription_has_horizon check (
    (risk_class = 'subscription_failure') = (lifetime_cycles is not null)
  );

comment on column txn.lifetime_cycles is
  'Expected remaining billing cycles if this subscription is saved. The value term for a '
  'subscription recovery is margin x cycles, not margin — losing the cycle usually means '
  'losing the subscriber.';

-- ---------------------------------------------------------------------------
-- A lapsed mandate is recurring AND has no mandate
-- ---------------------------------------------------------------------------
-- `txn_recurring_has_mandate` said: a recurring failure without a mandate reference is not
-- representable, because the mandate-expiry path would have nothing to escalate. That was
-- true when "the mandate expired" was a reason code hanging off an otherwise-live
-- subscription, and it is exactly wrong now that `mandate_lapsed` is a class of its own.
--
-- The whole meaning of that class is that NO LIVE AUTHORISATION EXISTS. Writing a reference
-- for one would make the row claim a mandate it does not have — and the engine reads exactly
-- that field to decide whether a debit needs a pre-debit notification, so the lie would make
-- it demand notice for a debit that can never legally happen.
--
-- So the invariant is narrowed rather than dropped: a recurring transaction needs a mandate
-- reference UNLESS its authorisation is the thing that lapsed.

alter table txn
  drop constraint txn_recurring_has_mandate;

alter table txn
  add constraint txn_recurring_has_mandate check (
    not is_recurring or mandate_ref is not null or risk_class = 'mandate_lapsed'
  );

alter table txn
  add constraint txn_lapsed_mandate_has_no_ref check (
    risk_class <> 'mandate_lapsed' or mandate_ref is null
  );

-- ---------------------------------------------------------------------------
-- Days overdue, for receivables
-- ---------------------------------------------------------------------------
-- B2B collection behaviour is driven by how late an invoice is, not by a retry count. Thirty
-- days late is a payment-run timing question; ninety days late is a dispute.

alter table txn
  add column days_overdue integer check (days_overdue is null or days_overdue >= 0);

alter table txn
  add constraint txn_receivable_has_age check (
    (risk_class = 'receivable_overdue') = (days_overdue is not null)
  );

-- ---------------------------------------------------------------------------
-- New intervention types
-- ---------------------------------------------------------------------------
-- Retrying a charge is only one way to recover money. A checkout abandonment cannot be
-- retried at all — there is nothing to charge — so its only intervention is a link. A lapsed
-- mandate needs re-authorisation. An overdue invoice needs a chaser, then a human.

alter table decision
  drop constraint decision_planned_action_check;

alter table decision
  add constraint decision_planned_action_check
    check (planned_action in (
      'retry',              -- re-present the same instrument
      'switch_rail',        -- re-present on a different rail
      'notify',             -- message only
      'escalate',           -- hand to a human
      'none',
      'payment_link',       -- send a fresh link for the customer to pay through
      'remandate',          -- ask the customer to re-authorise a mandate
      'pre_debit_notify',   -- the RBI-mandated notice before an e-mandate debit
      'await_promise'       -- a promise-to-pay is open; suppress action until its date
    ));

-- There is deliberately no `voice_call` action. A call is a `notify` whose template happens
-- to be registered on the `voice` channel — the template carries the channel, so a separate
-- action would be a second source of truth for the same fact, and the two would eventually
-- disagree about what the customer actually received.

-- `retry` and `switch_rail` are the only actions that present a charge, so they are the only
-- ones that may name a rail. A `payment_link` has no rail until the customer picks one.
alter table decision
  add constraint decision_rail_only_when_charging check (
    planned_rail is null or planned_action in ('retry', 'switch_rail')
  );

-- ---------------------------------------------------------------------------
-- Timing buckets for the new domains
-- ---------------------------------------------------------------------------
-- Not retry backoffs. The timing that matters is a property of the domain: an e-mandate
-- debit must be preceded by a day's notice, a B2B invoice is paid when the buyer's payment
-- run executes, and a broken promise is followed up the day after it broke.
--
-- `late_window` exists because of a knock-on effect worth recording in the schema itself:
-- once a debit needs 24 hours of notice, every sub-day backoff is legally unavailable on a
-- mandate rail. An issuer outage a one-off recovers in fifteen minutes cannot be chased that
-- way on a subscription at all.

alter table decision
  drop constraint decision_planned_timing_check;

alter table decision
  add constraint decision_planned_timing_check
    check (planned_timing in (
      'immediate', 'short_backoff', 'medium_backoff', 'next_day', 'salary_window', 'alt_rail',
      'pre_debit_window', 'late_window', 'payment_run_window', 'promise_followup'
    ));

-- ---------------------------------------------------------------------------
-- WHICH rule refused, as a column
-- ---------------------------------------------------------------------------
-- `verdict` says a decision was refused and `refuse_detail` says why in prose. Neither is
-- queryable: "how much expected recovery did the consent bound cost us this batch?" required
-- grepping English sentences, and the answer to that question is the price of the compliance
-- envelope — the single most useful number for deciding whether a bound is set correctly.
--
-- So the rule gets its own column. Prose stays, because an operator reading one exception
-- needs the sentence; the column is for the aggregate.
--
-- Note what this makes possible and what it does not. It quantifies the cost of each bound in
-- rupees of forgone expected recovery. It does NOT justify relaxing one: a bound that costs
-- money and exists for a legal reason is doing its job, and the number is there to be stated
-- rather than to be optimised away.

alter table decision
  add column refuse_rule text;

-- A refusal names its rule; a fired decision has none to name. Both halves enforced, so
-- neither can be forgotten by a future code path.
alter table decision
  add constraint decision_refusal_names_its_rule check (
    (verdict = 'fire') = (refuse_rule is null)
  );

create index decision_refuse_rule_idx on decision (batch_id, refuse_rule)
  where refuse_rule is not null;

comment on column decision.refuse_rule is
  'The specific bound that refused this decision — consent, quiet_hours, contact_ceiling, '
  'pre_debit_notice, promise_open, ev_floor, and so on. Queryable, so the cost of each '
  'guardrail is a number rather than a paragraph.';

-- ---------------------------------------------------------------------------
-- A fourth baseline
-- ---------------------------------------------------------------------------
-- B1 and B2 are retry baselines, and two of the five risk classes cannot be retried at all.
-- Without an untargeted MESSAGING baseline, the controller's results on checkout abandonment
-- and overdue receivables would only be measurable against doing nothing — a much easier bar
-- than the one the payment classes are held to, and a gap a careful reader would notice.
--
-- B4 is what an off-the-shelf abandoned-cart or dunning tool does: three generic reminders on
-- a fixed cadence, no diagnosis, no expected-value gate, no contact ceiling.

alter table batch
  drop constraint batch_arm_check;

alter table batch
  add constraint batch_arm_check
    check (arm in ('rc', 'b0', 'b1', 'b2', 'b3_oracle', 'b4'));

-- ---------------------------------------------------------------------------
-- The NCPR / DND registry
-- ---------------------------------------------------------------------------
-- Deliberately NOT a row in `consent_event`, and the separation is the point. Consent is an
-- agreement between the customer and the merchant; the registry is a standing instruction the
-- customer gave the telecom regulator, and it overrides merchant-level opt-in for outbound
-- calls. Modelling them as the same fact is how a system with a spotless consent table still
-- places an unlawful call.

alter table customer
  add column on_ncpr_registry boolean not null default false;

comment on column customer.on_ncpr_registry is
  'On the National Customer Preference Register (DND). Blocks outbound VOICE regardless of '
  'merchant-level consent. Separate from consent_event because it is a different authority '
  'with a different scope, and collapsing the two loses the distinction that matters.';

-- ---------------------------------------------------------------------------
-- Promise to pay
-- ---------------------------------------------------------------------------
-- A customer who says "I will pay on the 5th" has given you the single most valuable piece
-- of information in collections, and the correct response is to STOP CHASING until the 5th.
--
-- That makes this table a suppression mechanism as much as a tracker, which is why it fits
-- this system: the whole thesis is knowing when not to act. Chasing a customer who already
-- committed to a date is the clearest case of spending money to make an outcome worse.
--
-- Append-only on resolution: a promise is either kept, broken, or superseded by a new one,
-- and the history of which is what makes a customer's future promises worth more or less.

create table promise (
  id                bigserial   primary key,
  customer_id       uuid        not null references customer(id),
  txn_id            uuid        not null references txn(id) on delete cascade,

  promised_paise    bigint      not null check (promised_paise > 0),
  promised_for      timestamptz not null,

  -- How the promise was obtained. A commitment typed into a payment page is worth more than
  -- one inferred from an SMS reply, and the priors differ accordingly.
  obtained_via      text        not null check (obtained_via in (
                                  'sms_reply', 'voice_call', 'payment_page', 'agent_note'
                                )),
  obtained_at       timestamptz not null,

  status            text        not null default 'open'
                                check (status in ('open', 'kept', 'broken', 'superseded')),
  resolved_at       timestamptz,

  created_at        timestamptz not null default now(),

  -- A resolved promise has a resolution time; an open one does not. Prevents "was this
  -- kept?" from being unanswerable by omission.
  constraint promise_resolution_complete check (
    (status = 'open') = (resolved_at is null)
  )
);

-- At most one open promise per transaction. Two would make "is action suppressed?" depend on
-- which row was read first.
create unique index promise_one_open_per_txn
  on promise (txn_id) where status = 'open';

create index promise_customer_idx on promise (customer_id, promised_for desc);

comment on table promise is
  'Customer commitments to pay by a date. Primarily a SUPPRESSION mechanism: an open promise '
  'stops the system chasing until its date, because chasing someone who already committed '
  'spends money to make the outcome worse. Broken promises inform future priors.';

-- ---------------------------------------------------------------------------
-- Voice as a channel
-- ---------------------------------------------------------------------------
-- Voice is not SMS with a different body. In India it sits under a different consent regime
-- — the NCPR/DND registry, its own permitted calling window, and its own per-day limits —
-- and it costs roughly twenty times as much. Both facts belong in the model, because the
-- expected-value gate is what should decide between a cheap message and an expensive call.

alter table consent_event
  drop constraint consent_event_channel_check;

alter table consent_event
  add constraint consent_event_channel_check
    check (channel in ('sms', 'whatsapp', 'email', 'voice'));

alter table message_template
  drop constraint message_template_channel_check;

alter table message_template
  add constraint message_template_channel_check
    check (channel in ('sms', 'whatsapp', 'email', 'voice'));

alter table message_send
  drop constraint message_send_channel_check;

alter table message_send
  add constraint message_send_channel_check
    check (channel in ('sms', 'whatsapp', 'email', 'voice'));

-- Voice scripts are registered like SMS templates. The model fills variables inside an
-- approved script; it does not improvise what a customer hears.
comment on column message_template.channel is
  'Delivery channel. Voice carries its own consent regime (NCPR/DND), its own calling '
  'window, and roughly 20x the cost of SMS — so the expected-value gate, not a preference '
  'setting, decides when a call is worth placing.';
