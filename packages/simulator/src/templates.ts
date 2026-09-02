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

  // --- pre-debit notification --------------------------------------------
  //
  // The one message here that is legally REQUIRED rather than commercially chosen. Under RBI
  // e-mandate rules a recurring debit must be preceded by a notification at least 24 hours
  // ahead, stating the amount and the date — so the body below names both, and the engine
  // refuses the debit outright if this never reached the customer.
  {
    id: 'tpl_predebit_notice_v1',
    family: 'predebit_notice',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000009',
    body:
      'Hi {{name}}, Rs {{amount}} will be debited for your {{merchant}} subscription on ' +
      '{{date}} using your saved autopay. To pay now or change it: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'date', 'link'],
  },
  {
    id: 'tpl_predebit_notice_hi_v1',
    family: 'predebit_notice',
    channel: 'sms',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000010',
    body:
      'Hi {{name}}, aapke {{merchant}} subscription ke liye Rs {{amount}} {{date}} ko autopay ' +
      'se debit hoga. Abhi pay karna ya badalna ho: {{link}}. Band karne ke liye STOP bhejein.',
    variables: ['name', 'amount', 'merchant', 'date', 'link'],
  },

  // --- checkout recovery --------------------------------------------------
  //
  // Three families rather than one, matching the three strategies. The copy differs because
  // the SITUATION differs, and that is the whole argument for splitting the funnel into
  // separate causes: telling someone who never entered a card that their "payment did not
  // complete" is confusing, and telling someone whose OTP failed to "come back and shop" is
  // insulting. A single blended abandoned-cart template gets both wrong.
  {
    id: 'tpl_otp_resume_v1',
    family: 'otp_resume',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000011',
    body:
      'Hi {{name}}, your Rs {{amount}} payment to {{merchant}} stopped at the OTP step. ' +
      'Your order is still held — finish here, no OTP wait: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_otp_resume_hi_v1',
    family: 'otp_resume',
    channel: 'sms',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000012',
    body:
      'Hi {{name}}, {{merchant}} ka Rs {{amount}} payment OTP wale step par ruk gaya. Aapka ' +
      'order safe hai — yahan se poora karein: {{link}}. Band karne ke liye STOP bhejein.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_checkout_resume_v1',
    family: 'checkout_resume',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000013',
    body:
      'Hi {{name}}, your {{merchant}} order for Rs {{amount}} is still saved. Pick your ' +
      'payment method and finish here: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_checkout_resume_hi_v1',
    family: 'checkout_resume',
    channel: 'sms',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000014',
    body:
      'Hi {{name}}, aapka {{merchant}} order Rs {{amount}} ka save hai. Payment method ' +
      'chunkar poora karein: {{link}}. Band karne ke liye STOP bhejein.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_cart_nudge_v1',
    family: 'cart_nudge',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000015',
    body:
      'Hi {{name}}, you left items worth Rs {{amount}} in your {{merchant}} cart. They are ' +
      'still there: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },
  {
    id: 'tpl_cart_nudge_hi_v1',
    family: 'cart_nudge',
    channel: 'sms',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000016',
    body:
      'Hi {{name}}, aapke {{merchant}} cart mein Rs {{amount}} ke items rakhe hain. Abhi bhi ' +
      'available hain: {{link}}. Band karne ke liye STOP bhejein.',
    variables: ['name', 'amount', 'merchant', 'link'],
  },

  // --- receivables --------------------------------------------------------
  //
  // Four families, because B2B non-payment has four different blockers and one message
  // cannot address them. The approver chaser asks to be routed onward; the payment-run
  // reminder names the run; the general chaser states the age; the broken-promise script
  // references the commitment. Sending the general chaser to an invoice stuck behind an
  // approver is the single most common wasted message in receivables.
  {
    id: 'tpl_ar_approver_v1',
    family: 'ar_approver',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000017',
    body:
      'Hi {{name}}, invoice {{invoice}} for Rs {{amount}} from {{merchant}} is awaiting ' +
      'approval. Could you forward it to the approver? Details: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'invoice', 'link'],
  },
  {
    id: 'tpl_ar_run_reminder_v1',
    family: 'ar_run_reminder',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000018',
    body:
      'Hi {{name}}, invoice {{invoice}} for Rs {{amount}} from {{merchant}} missed the last ' +
      'payment run. To include it in the next one: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'invoice', 'link'],
  },
  {
    id: 'tpl_ar_chase_v1',
    family: 'ar_chase',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000019',
    body:
      'Hi {{name}}, invoice {{invoice}} for Rs {{amount}} from {{merchant}} is {{days}} days ' +
      'overdue. Pay or raise a query here: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'invoice', 'days', 'link'],
  },
  {
    id: 'tpl_ar_promise_broken_v1',
    family: 'ar_promise_broken',
    channel: 'sms',
    language: 'en',
    dltTemplateId: 'DLT1207160000000020',
    body:
      'Hi {{name}}, invoice {{invoice}} for Rs {{amount}} was expected by {{date}} and is ' +
      'still open. Pay or tell us a new date: {{link}}. Reply STOP to opt out.',
    variables: ['name', 'amount', 'merchant', 'invoice', 'date', 'link'],
  },

  // --- voice: the escalation step ----------------------------------------
  //
  // REGISTERED SCRIPTS, not generated speech, and the distinction is the same one that
  // governs SMS: the model fills variables inside an approved script and does not decide
  // what a customer hears. An agent that improvises on a call is less shippable than one
  // that improvises in text, not more, because there is no send-time review of audio.
  //
  // The Hinglish variant is the interesting one commercially. Code-mixed Hindi-English is how
  // a large share of Indian customers actually speak about money, and a stilted pure-Hindi
  // script performs worse than English — so this is a registered variant selected by the
  // customer's `preferred_language`, exactly like the SMS families above.
  {
    id: 'tpl_ar_voice_final_v1',
    family: 'ar_voice_final',
    channel: 'voice',
    language: 'en',
    dltTemplateId: 'DLT1207160000000021',
    body:
      'Hello, this is an automated call from {{merchant}} about invoice {{invoice}} for ' +
      'rupees {{amount}}, which is {{days}} days overdue. Press 1 to receive a payment link ' +
      'by SMS, press 2 to speak to our accounts team, or press 9 to stop these calls.',
    variables: ['merchant', 'invoice', 'amount', 'days'],
  },
  {
    id: 'tpl_ar_voice_final_hi_v1',
    family: 'ar_voice_final',
    channel: 'voice',
    language: 'hi_latn',
    dltTemplateId: 'DLT1207160000000022',
    body:
      'Namaste, yeh {{merchant}} ki taraf se automated call hai. Invoice {{invoice}}, rupees ' +
      '{{amount}} ka payment {{days}} din se pending hai. Payment link SMS par chahiye to 1 ' +
      'dabaayein, accounts team se baat karni ho to 2 dabaayein, yeh calls band karne ke liye ' +
      '9 dabaayein.',
    variables: ['merchant', 'invoice', 'amount', 'days'],
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
