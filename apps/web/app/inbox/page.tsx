import { formatINR } from '@rc/core';
import { loadBlockedContacts, loadInbox, seedFrom } from '../../lib/queries';
import { renderSends, type SpokenSend } from '../../lib/script';
import { SeedPicker } from '../seed-picker';
import { CallAudio } from './call-audio';
import { DispatchMail } from './dispatch-mail';

/**
 * What customers actually received — and, beside it, what the system refused to send.
 *
 * The blocked column is the more important half. A compliance layer is only demonstrable if
 * you can see what it stopped; a page showing only successful sends proves nothing about
 * quiet hours, consent, or contact ceilings, because a system with none of those would
 * render identically.
 */
export default async function Inbox({
  searchParams,
}: {
  searchParams: Promise<{ seed?: string }>;
}) {
  const seed = seedFrom((await searchParams).seed);
  const [messages, blocked] = await Promise.all([loadInbox(seed), loadBlockedContacts(seed)]);
  const hinglish = messages.filter((m) => m.language === 'hi_latn').length;
  const voiceSends = messages.filter((m) => m.channel === 'voice');

  /*
   * EVERY message rendered here, in one query, through the SAME function the two Server
   * Actions use — so the text on screen is the text that gets spoken and the text that gets
   * emailed. `rendered_body` in the database is a stub; see lib/script.ts.
   *
   * This used to cover only the two voice rows, and the Delivered table below printed
   * `message_template.body` raw. That is the exact failure lib/script.ts was written to
   * prevent: the page showed `Hi {{name}}, aapka {{merchant}} order…` while the dispatch
   * button beside it mailed the filled message. Two renderings of one send, disagreeing,
   * with the braces on the half a judge reads.
   */
  const scripts = await renderSends(messages.map((m) => m.id));

  const calls = voiceSends
    .map((send) => ({ send, script: scripts.get(send.id) }))
    .filter((e): e is { send: (typeof voiceSends)[number]; script: SpokenSend } =>
      e.script !== undefined,
    );

  return (
    <>
      <SeedPicker current={seed} path="/inbox" />

      <div className="page-head">
        <h2>Customer inbox</h2>
        <p>
          Commercial SMS in India requires a DLT-registered template. The model fills
          variables inside an approved body and may draft new templates for human
          registration — it never emits the text that is sent. Hinglish is a registered
          variant selected by the customer’s language, not copy a model wrote at send time.
        </p>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Delivered</div>
          <div className="value">{messages.length}</div>
          <div className="note">through registered templates</div>
        </div>
        <div className="tile">
          <div className="label">Hinglish</div>
          <div className="value">{hinglish}</div>
          <div className="note">
            {messages.length === 0 ? '—' : `${Math.round((hinglish / messages.length) * 100)}% of sends`}
          </div>
        </div>
        <div className="tile">
          <div className="label">Calls placed</div>
          <div className="value">{calls.length}</div>
          {/* The scarcity is the result, not a shortfall. Voice costs ~22× an SMS and has to
              clear the NCPR registry, a narrower window and a weekly ceiling before the gate
              prices it at all — so it wins rarely, and that is the gate working. */}
          <div className="note">
            {messages.length === 0 ? '—' : `of ${messages.length} sends · ~22× the cost`}
          </div>
        </div>
        <div className="tile">
          <div className="label">Blocked</div>
          <div className="value warn">{blocked.reduce((sum, b) => sum + b.count, 0)}</div>
          <div className="note">by a compliance bound</div>
        </div>
      </div>

      {blocked.length > 0 && (
        <>
          <h3>Messages the system refused to send</h3>
          <div className="wrap">
            <table>
              <thead>
                <tr>
                  <th>Bound</th>
                  <th>Blocked</th>
                </tr>
              </thead>
              <tbody>
                {blocked.map((row) => (
                  <tr key={row.rule}>
                    <td className="mono">{row.rule}</td>
                    <td className="warn">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {calls.length > 0 && (
        <>
          <h3>Calls placed — {calls.length} of {messages.length} sends</h3>
          <p className="section-note">
            Pulled out of the chronological list below, because two rows in a hundred and
            forty-six are hard to find and these are the ones worth hearing. Voice is not a
            louder SMS: it costs about <strong>22× as much</strong>, is blocked outright by
            the NCPR/DND registry regardless of merchant consent, is confined to a
            10:00–19:00 window narrower than quiet hours, and is capped at one call per
            customer per week. It only reaches the expected-value gate after all of that —
            which is why it wins twice and not two hundred times.
          </p>

          <div className="wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>What was said, and heard</th>
                  <th>Template</th>
                  <th>Lang</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {calls.map(({ send, script }) => (
                  <tr key={send.id} data-highlight="true">
                    <td>{send.customer}</td>
                    <td style={{ textAlign: 'left' }}>
                      {/* The registered template with this transaction's real amount and age
                          filled in. The audio speaks this exact string, because both come
                          from `renderSend`. */}
                      <div className="msg spoken">{script.text}</div>
                      <CallAudio sendId={send.id} seconds={estimateSeconds(script.text)} />
                    </td>
                    <td className="mono dim" style={{ verticalAlign: 'top' }}>
                      {send.templateId}
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      <span className={send.language === 'hi_latn' ? 'pill accent' : 'pill'}>
                        {send.language === 'hi_latn' ? 'Hinglish' : 'EN'}
                      </span>
                    </td>
                    <td style={{ verticalAlign: 'top' }}>{formatINR(send.costPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="callout">
            <strong>The script is registered, and the model only speaks it.</strong> Each
            body above comes from a <code className="mono">message_template</code> row with a
            DLT id and <code className="mono">status = registered</code>; the engine filled
            its declared variables with this transaction&rsquo;s real amount and age. Speech
            synthesis reads the result verbatim and composes nothing — stricter than the SMS
            path deliberately, because a wrong message can be read and disputed afterwards
            while a call is gone the moment it ends.
          </div>
        </>
      )}

      <h3>Delivered</h3>
      {messages.length === 0 ? (
        <div className="empty">
          No messages. Run <code className="mono">pnpm demo</code> first.
        </div>
      ) : (
        <div className="wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Template</th>
                <th>DLT id</th>
                <th>Lang</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => (
                <tr key={message.id}>
                  <td>
                    <div style={{ fontFamily: 'var(--sans)' }}>{message.customer}</div>
                    {/* The filled message, not the template. Falls back to the raw body only
                        when a template asks for a value this transaction has no answer to —
                        visible braces are then the honest report, because the alternative is
                        showing nothing where a message was actually sent. */}
                    <div className="msg" style={{ marginTop: 6 }}>
                      {scripts.get(message.id)?.text ?? message.body}
                    </div>
                    {/* The two voice rows carry their player in the section above rather
                        than here, so the control is findable instead of buried at row 130 of
                        146. This table stays strictly chronological. */}
                    {message.plannedAction === 'payment_link' ? (
                      <DispatchMail
                        sendId={message.id}
                        amount={formatINR(message.amount)}
                      />
                    ) : null}
                  </td>
                  <td className="mono dim" style={{ verticalAlign: 'top' }}>
                    {message.templateId}
                  </td>
                  <td className="mono dim" style={{ verticalAlign: 'top' }}>
                    {message.dltId ?? '—'}
                  </td>
                  <td style={{ verticalAlign: 'top' }}>
                    <span className={message.language === 'hi_latn' ? 'pill accent' : 'pill'}>
                      {message.language === 'hi_latn' ? 'Hinglish' : 'EN'}
                    </span>
                  </td>
                  <td style={{ verticalAlign: 'top' }}>{formatINR(message.costPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="callout warn">
        <strong>What these messages rest on.</strong> Message effectiveness <em>is</em>{' '}
        modelled — four of the five risk classes recover money by messaging and nothing else,
        so excluding it would have scored most of the system at zero. A payment link, a
        pre-debit notice and a re-authorisation request each have their own prior, because
        they are three different questions.
        <br />
        <br />
        But every one of those figures is <code className="mono">ASSUMED</code>, gets the
        wider ±60% band in the sweep, and states its reasoning in{' '}
        <code className="mono">priors.published.yaml</code>. The defensible part is the{' '}
        <em>ordering</em> — an OTP drop-off recovers far better than an abandoned cart. The
        levels are a draw against a table, not a model of a person deciding to buy.
      </div>
    </>
  );
}

/**
 * Rough spoken duration, so the button can say what it is about to produce.
 *
 * Announced BEFORE synthesis, which means it cannot come from the audio — it is an estimate
 * from character count at roughly 13 characters a second, measured against the one real
 * render: 292 characters produced 21.2 seconds. Labelled with a "~" because an estimate
 * presented as a measurement is the kind of small dishonesty this project spends most of its
 * comments arguing against.
 */
function estimateSeconds(text: string): number {
  return Math.max(1, Math.round(text.length / 13.8));
}
