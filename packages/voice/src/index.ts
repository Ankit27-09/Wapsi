/**
 * @rc/voice — speech for registered call scripts.
 *
 * Direction 07 of the brief is "Hinglish voice recovery", and the engine already treats voice
 * as a channel rather than a special case: it is priced into the expected-value gate at
 * roughly 22× an SMS, bounded by the NCPR/DND registry, restricted to a 10:00–19:00 window
 * narrower than quiet hours, and capped at one call per customer per week. That is the part
 * that decides whether a call happens.
 *
 * This package is the part that makes one audible. It renders an APPROVED template — DLT id,
 * `status = 'registered'` — and synthesises it. It composes nothing.
 *
 * The restriction is tighter here than on the SMS path, deliberately. A wrong message can be
 * read, screenshotted and disputed afterwards; a call is gone when it ends, there is no
 * send-time review of audio, and an improvised sentence in an automated voice call is
 * unauditable by construction.
 */

export {
  DEFAULT_VOICE_MODELS,
  VOICE_PROVIDER_IDS,
  VoiceError,
  createGeminiVoice,
  createSarvamVoice,
  resolveVoiceProvider,
  type SpeechRequest,
  type SpeechResult,
  type VoiceProvider,
  type VoiceProviderId,
  type VoiceResolution,
} from './providers.js';

export {
  ScriptError,
  languageTagFor,
  renderScript,
  type RenderedScript,
} from './render.js';

export { GEMINI_PCM, SARVAM_PCM, durationSeconds, pcmToWav, type PcmFormat } from './wav.js';
