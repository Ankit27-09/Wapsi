import { formatINR } from '@rc/core';
import { loadBlockedContacts, loadInbox } from '../../lib/queries';

/**
 * What customers actually received — and, beside it, what the system refused to send.
 *
 * The blocked column is the more important half. A compliance layer is only demonstrable if
 * you can see what it stopped; a page showing only successful sends proves nothing about
 * quiet hours, consent, or contact ceilings, because a system with none of those would
 * render identically.
 */
export default async function Inbox() {
  const [messages, blocked] = await Promise.all([loadInbox(), loadBlockedContacts()]);
  const hinglish = messages.filter((m) => m.language === 'hi_latn').length;

  return (
    <>
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
                    <div className="msg" style={{ marginTop: 6 }}>
                      {message.body}
                    </div>
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
        <strong>These messages cost money and recover none of it.</strong> The truth model has
        no notion of a customer responding to a nudge, so every send above appears as cost in
        the reported net value and as zero recovery. The compliance layer is real and
        exercised; any claim that the nudges <em>work</em> would not be.
      </div>
    </>
  );
}
