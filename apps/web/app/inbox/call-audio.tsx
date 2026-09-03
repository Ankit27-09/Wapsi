'use client';

import { useState, useTransition } from 'react';
import { speak, type SpeakResult } from './speak';

/**
 * Play the call, synthesising it on first click.
 *
 * The second client component in the application, and the only one that does more than read
 * the pathname. It exists because synthesis takes seventeen seconds on a free-tier key and a
 * button with no state during that is indistinguishable from a broken one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not choose to place a call, does not compose the
 * script, and cannot be pointed at an arbitrary row — it passes a `message_send` id to a
 * Server Action that refuses anything whose channel is not `voice`. The button is a speaker,
 * not a decision.
 *
 * The wait is named rather than hidden. A spinner says "something is happening"; "calling
 * gemini — about 15s" says what and roughly how long, which is the difference between a
 * judge waiting and a judge assuming it hung.
 */

export function CallAudio({ sendId, seconds }: { sendId: number; seconds: number }) {
  const [result, setResult] = useState<SpeakResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (result?.ok === true && result.url !== null) {
    return (
      <div className="call-audio">
        {/* Native controls rather than a custom player. A judge knows what a play button
            does, and a bespoke transport would be code with nothing to prove. */}
        <audio controls preload="metadata" src={result.url} className="call-player" />
        <span className="call-note">
          {result.cached
            ? 'cached — no second call was made'
            : `${result.provider ?? 'synthesised'} · ${result.seconds ?? '?'}s`}
        </span>
      </div>
    );
  }

  return (
    <div className="call-audio">
      <button
        type="button"
        className="btn call-btn"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            setResult(await speak(sendId));
          });
        }}
      >
        {pending ? 'Synthesising…' : `▶ Hear this call · ~${seconds}s of audio`}
      </button>

      {pending ? (
        // Measured, not guessed, and it changed once Sarvam was configured: Gemini took
        // 17.5s for this script and Sarvam 2.7s for the same 292 characters. The copy said
        // "15–20s" while the configured provider was six times faster, which is the kind of
        // pessimism that reads as a broken estimate rather than a cautious one.
        <span className="call-note">
          calling the speech provider — a few seconds, then cached
        </span>
      ) : null}

      {result?.ok === false && result.error !== null ? (
        // Shown in full rather than as "failed". The likely cause is a rate limit, and an
        // operator who can read that will try again in a minute instead of assuming the
        // integration is broken.
        <span className="call-error">{result.error}</span>
      ) : null}
    </div>
  );
}
