import type { Channel, Db } from '@rc/db';

/**
 * DLT-REGISTERED MESSAGE TEMPLATES
 *
 * In India, commercial SMS requires a template registered on the DLT platform, and WhatsApp
 * business messaging requires a pre-approved one. A recovery agent that free-generates
 * message text is not shippable however good the copy is.
 *
 * That constraint shapes the whole messaging design, and it is worth stating plainly because
 * it is the opposite of what "AI writes the customer message" suggests:
 *
 *   The model does NOT write what is sent. It fills variables inside an approved body, and
 *   it may DRAFT new templates into this table with status `draft_pending_review` for a
 *   human to register. There is no column in which free-form model output could be sent —
 *   `message_send.template_id` is NOT NULL and references a registered row.
 *
 * The Hinglish variants are the same rule applied honestly. They are registered templates
 * with their own DLT ids, selected by the customer's `preferred_language`, not text a model
 * produced at send time. This is the only version of "Hinglish recovery" that could
 * actually go live.
 *
 * `dlt_template_id` values below are synthetic. Real registration is an operational step
 * with a real operator, and the README says so in the limitations section rather than
 * implying these are live.
 */

interface TemplateSeed {
  readonly id: string;
  readonly family: string;
  readonly channel: Channel;
  readonly language: 'en' | 'hi_latn';
  readonly dltTemplateId: string;
  readonly body: string;
  readonly variables: readonly string[];
}

/**
 * Variables are named, not positional.
 *
 * A positional template is one refactor away from putting an amount where a name belongs,
 * and the failure is invisible in review because both are strings.
 */
const TEMPLATES: readonly TemplateSeed[] = [
  // --- insufficient funds: retry reminder ---------------------------------
  {
    id: 'tpl_if_reminder_v3',
    family: 'if_reminder',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000001',
    body:
      'Hi {{name}}, your payment of Rs {{amount}} to {{merchant}} could not be completed ' +
      'due to insufficient balance. You can retry here: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_if_reminder_hi_v3',
    family: 'if_reminder',
    channel: 'sms',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000002',
    body:
      'Hi {{name}}, {{merchant}} ko Rs {{amount}} ka payment balance kam hone ki wajah se ' +
      'complete nahi hua. Dobara try karein: {{link}}. Band karne ke liye STOP bhejein.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },

  // --- 3DS timeout: try a different rail ----------------------------------
  {
    id: 'tpl_alt_rail_v2',
    family: 'alt_rail',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000003',
    body:
      'Hi {{name}}, your card payment of Rs {{amount}} to {{merchant}} did not complete ' +
      'verification. Pay by UPI instead: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_alt_rail_hi_v2',
    family: 'alt_rail',
    channel: 'sms',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000004',
    body:
      'Hi {{name}}, {{merchant}} ka Rs {{amount}} ka card payment verify nahi hua. UPI se ' +
      'pay karein: {{link}}. Band karne ke liye STOP bhejein.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },

  // --- expired card: needs a new instrument -------------------------------
  {
    id: 'tpl_update_card_v4',
    family: 'update_card',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000005',
    body:
      'Hi {{name}}, the card saved for {{merchant}} has expired, so Rs {{amount}} could ' +
      'not be collected. Update it here: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_update_card_hi_v4',
    family: 'update_card',
    channel: 'sms',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000006',
    body:
      'Hi {{name}}, {{merchant}} ke liye saved card expire ho gaya hai, is liye Rs ' +
      '{{amount}} collect nahi hua. Update karein: {{link}}. Band karne ke liye STOP bhejein.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },

  // --- lapsed mandate: needs re-authorisation ----------------------------
  {
    id: 'tpl_remandate_v2',
    family: 'remandate',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000007',
    body:
      'Hi {{name}}, your autopay authorisation for {{merchant}} has expired, so Rs ' +
      '{{amount}} could not be collected. Re-authorise here: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_remandate_hi_v2',
    family: 'remandate',
    channel: 'sms',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000008',
    body:
      'Hi {{name}}, {{merchant}} ke liye autopay permission expire ho gayi hai, is liye Rs ' +
      '{{amount}} collect nahi hua. Phir se allow karein: {{link}}. Band karne ke liye STOP bhejein.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
];

/**
 * Seed the registered templates. Idempotent, so it is safe before every batch.
 *
 * Every row is inserted with `status = 'registered'` AND a `dlt_template_id`, because the
 * schema's `template_registered_has_dlt_id` constraint refuses the combination that would
 * make "registered" a label rather than a fact.
 */
export async function ensureTemplatesSeeded(db: Db): Promise<void> {
  await db
    .insertInto('message_template')
    .values(
      TEMPLATES.map((template) => ({
        id: template.id,
        family: template.family,
        dlt_template_id: template.dltTemplateId,
        channel: template.channel,
        language: template.language,
        body: template.body,
        variables: template.variables as string[],
        status: 'registered' as const,
      })),
    )
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

/** Exported for the report, so the pitch can show exactly what a customer receives. */
export function registeredTemplates(): readonly TemplateSeed[] {
  return TEMPLATES;
}
