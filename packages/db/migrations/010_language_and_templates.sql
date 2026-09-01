-- 010_language_and_templates.sql
--
-- Make the messaging path reachable, and make the Hinglish variant a real selection rather
-- than a second row nobody picks.
--
-- WHY THIS WAS NEEDED: the eval reported `contactsSent = 0` on every arm. The behaviour was
-- correct — no `consent_event` rows existed, so every send was blocked by the consent bound
-- — but it meant the DLT templates, the Hinglish copy and the customer inbox had nothing
-- exercising them. A compliance layer that is never reached is a compliance layer nobody
-- has tested.
--
-- Two additions:
--
--   `customer.preferred_language` — which variant this customer should receive. Without it,
--     a Hinglish template is a row in a table with no path to being chosen, and "we support
--     Hinglish" reduces to "we wrote some Hinglish".
--
--   `message_template.family` — groups language variants of the same message. The policy
--     keeps naming a single readable template id; the resolver maps that id to its family
--     and then to the variant matching the customer. Policy YAML stays legible and the
--     language decision lives with the customer, which is where it belongs.

-- ---------------------------------------------------------------------------
-- Customer language
-- ---------------------------------------------------------------------------
-- `hi_latn` is Hindi written in Latin script — Hinglish. Not `hi`: Devanagari is a
-- different rendering problem with different DLT templates, and conflating the two would
-- eventually send the wrong script to somebody.

alter table customer
  add column preferred_language text not null default 'en'
    check (preferred_language in ('en', 'hi_latn'));

comment on column customer.preferred_language is
  'Which registered template variant this customer receives. Hinglish (hi_latn) is Hindi '
  'in Latin script, deliberately distinct from Devanagari.';

-- ---------------------------------------------------------------------------
-- Template families
-- ---------------------------------------------------------------------------

alter table message_template
  add column family text;

update message_template set family = id where family is null;

alter table message_template
  alter column family set not null;

-- One registered variant per (family, channel, language). Without this, two registered
-- Hinglish SMS variants of the same message could coexist and which one sent would depend
-- on row order — a non-deterministic choice about what a customer receives.
create unique index message_template_variant_uq
  on message_template (family, channel, language)
  where status = 'registered';

comment on column message_template.family is
  'Groups language variants of one message. The policy names a specific template id; the '
  'resolver maps it to this family and picks the variant matching the customer language.';
