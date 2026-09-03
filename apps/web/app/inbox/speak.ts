'use server';

import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ScriptError,
  VoiceError,
  languageTagFor,
  pcmToWav,
  resolveVoiceProvider,
} from '@rc/voice';
import { db } from '../../lib/db';
import { renderSend } from '../../lib/script';

/**
 * Synthesise the audio for a call the engine ALREADY DECIDED TO PLACE.
 *
 * The one write path in an otherwise read-only console, and the boundary is the whole design.
 * It does not choose to call anybody, does not compose a sentence, and cannot be pointed at an
 * arbitrary transaction. It takes a `message_send` row, refuses it unless the channel is
 * `voice`, and speaks the registered script for that send filled with that transaction's real
 * amount and age.
 *
 * WHERE THE TEXT COMES FROM, and it is not `rendered_body`. That column is a stub — the
 * engine writes the literal string `[template tpl_ar_voice_final_hi_v1]` with a comment
 * saying variable filling was deferred to a renderer that was never built. So it names the
 * template and does not contain the message. `lib/script.ts` carries the full note and
 * FAILURES.md records the gap; the short version is that this action renders the same
 * template the engine referenced from the same data the engine had, which invents nothing but
 * is a viewer reconstructing the message rather than reading it back.
 *
 * Rendering goes through `renderSend`, the same function the page displays from, so what is
 * heard is what is shown. Two derivations is how a viewer ends up playing a script it is not
 * displaying.
 *
 * WHY IT REFUSES A NON-VOICE ROW. An SMS is reviewable after the fact — it is on the
 * customer's phone. A call is gone when it ends, so "the system will read any message aloud
 * on request" is a materially different capability from the one the policy authorised. The
 * check is a `where` clause, not a convention.
 */

export interface SpeakResult {
  readonly ok: boolean;
  /** Public URL of the audio, when it exists. */
  readonly url: string | null;
  /** What went wrong, in a sentence a person can act on. */
  readonly error: string | null;
  /** True when a cached file was served rather than a new call made. */
  readonly cached: boolean;
  readonly provider: string | null;
  readonly seconds: number | null;
}

/** Where the files land. Served by Next as static assets from `/audio/…`. */
const AUDIO_DIR = join(process.cwd(), 'public', 'audio');

/**
 * Filename derived from the send id AND a hash of the text.
 *
 * Keyed on both so a re-seeded batch cannot serve stale audio: the send ids restart, and a
 * file named for an id alone would be reused for a different customer's script. The hash
 * makes the name a function of what is actually spoken.
 */
function fileNameFor(sendId: number, text: string): string {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `send-${sendId}-${digest}.wav`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function speak(sendId: number): Promise<SpeakResult> {
  const empty = { url: null, cached: false, provider: null, seconds: null };

  // THE AUTHORISATION, and it is a query rather than a check on a passed-in value. A caller
  // cannot claim a row is a voice send; the database decides.
  const authorised = await db()
    .selectFrom('message_send')
    .select('id')
    .where('id', '=', sendId)
    .where('channel', '=', 'voice')
    .executeTakeFirst();

  // Rendered through the same function the page displays from, so what is heard is what is
  // shown. Deriving it twice is how a viewer plays a script it is not showing.
  const send = authorised === undefined ? null : await renderSend(sendId);

  if (send === null) {
    return {
      ok: false,
      ...empty,
      error:
        'No voice send with that id. Audio is only available for a call the engine actually ' +
        'decided to place — 2 of 146 sends in this batch.',
    };
  }

  const fileName = fileNameFor(send.sendId, send.text);
  const url = `/audio/${fileName}`;
  const path = join(AUDIO_DIR, fileName);

  // Cached first, so a second click costs nothing. A demo gets clicked more than once, and a
  // free-tier key that runs out mid-presentation is a bad way to find that out.
  if (await exists(path)) {
    return { ok: true, ...empty, url, cached: true, error: null };
  }

  const { provider, problem } = resolveVoiceProvider();
  if (provider === null) {
    return { ok: false, ...empty, error: problem ?? 'No speech provider is configured.' };
  }

  try {
    const started = Date.now();
    const result = await provider.speak({
      text: send.text,
      language: languageTagFor(send.language),
      voice: null,
    });

    await mkdir(AUDIO_DIR, { recursive: true });
    await writeFile(path, pcmToWav(result.pcm, result.format));

    return {
      ok: true,
      url,
      cached: false,
      error: null,
      provider: `${result.provider}:${result.model}`,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } catch (cause) {
    // A rate limit is the single most likely failure on a free-tier key, and a dead spinner
    // is the worst way to present it. Every branch returns a sentence rather than throwing,
    // so the button can say what happened and stay clickable.
    if (cause instanceof VoiceError || cause instanceof ScriptError) {
      return { ok: false, ...empty, error: cause.message };
    }
    return {
      ok: false,
      ...empty,
      error: cause instanceof Error ? cause.message : 'Speech synthesis failed.',
    };
  }
}
