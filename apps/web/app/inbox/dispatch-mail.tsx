'use client';

import { useState, useTransition } from 'react';
import { dispatch, type DispatchResult } from './dispatch';

/**
 * Send this decision's message, and its arithmetic, to the operator's own inbox.
 *
 * Client state for one reason: the round trip is two network calls — a Razorpay lookup to
 * find the existing link, then Resend — and a button that goes dead for three seconds is
 * indistinguishable from a broken one.
 *
 * The label says WHERE it goes, once the send has happened. Not decoration: this is a preview
 * addressed to the operator, and a button that said only "Sent" would let a viewer assume a
 * customer had been contacted, which is precisely the thing the engine's compliance layer
 * refuses to let happen.
 */

export function DispatchMail({ sendId, amount }: { sendId: number; amount: string }) {
  const [result, setResult] = useState<DispatchResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="dispatch">
      <button
        type="button"
        className="btn dispatch-btn"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            setResult(await dispatch(sendId));
          });
        }}
      >
        {pending ? 'Dispatching…' : `✉ Dispatch ${amount} to my inbox`}
      </button>

      {pending ? (
        <span className="dispatch-note">
          finding the issued Razorpay link, then sending — a couple of seconds
        </span>
      ) : null}

      {result?.ok === true ? (
        <span className="dispatch-ok">
          Sent to <strong>{result.to}</strong>
          {result.paymentUrl === null ? '' : ' with the live payment link'}. Refresh your mail.
        </span>
      ) : null}

      {/* A warning is not a failure: the mail went, the link did not. Shown separately so
          those two outcomes are never conflated into "something went wrong". */}
      {result?.warning !== null && result?.warning !== undefined ? (
        <span className="dispatch-warn">{result.warning}</span>
      ) : null}

      {result?.ok === false && result.error !== null ? (
        <span className="dispatch-error">{result.error}</span>
      ) : null}
    </div>
  );
}
