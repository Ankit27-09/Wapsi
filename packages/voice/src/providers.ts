import { z } from 'zod';
import { GEMINI_PCM, SARVAM_PCM, type PcmFormat } from './wav.js';

/**
 * Speech synthesis, behind one interface, for the same reason the classifier is.
 *
 * `@rc/ai` took Gemini and Groq behind a single `Provider` type and that turned a vendor
 * swap into a config change. Voice gets the same treatment, and here it matters more: the
 * commercially interesting provider for Hinglish is Sarvam, whose Bulbul model is built for
 * Indian code-mixing, and the one already configured is Gemini. Both are wired, selection is
 * an environment variable, and neither is load-bearing on the other.
 *
 * WHAT THIS LAYER DOES NOT DO, and the boundary is the point: it renders text that has
 * already been approved. It never composes a sentence. Every script it speaks comes from
 * `message_template` with `status = 'registered'` and a DLT id, the model fills declared
 * variables into it, and nothing else reaches a customer's ear.
 *
 * That is stricter than the SMS path rather than looser, and deliberately so. A wrong SMS can
 * be read, screenshotted and disputed after the fact. A call is gone the moment it ends,
 * there is no send-time review of audio, and an improvised sentence in an automated voice
 * call is unauditable by construction — so improvisation is not available here at all.
 */

export const VOICE_PROVIDER_IDS = ['gemini', 'sarvam'] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

export interface SpeechRequest {
  /** The rendered script. Already approved, already variable-filled. */
  readonly text: string;
  /**
   * BCP-47-ish tag the provider understands.
   *
   * `hi-IN` for the Hinglish scripts, which is correct even though the text is Latin-script:
   * the target is Hindi PHONOLOGY applied to code-mixed text. Tagging it `en-IN` makes a
   * provider read "dabaayein" with English vowels, which is worse than either pure language.
   */
  readonly language: string;
  /** Provider-specific voice name. Null takes the provider's default. */
  readonly voice: string | null;
}

export interface SpeechResult {
  /** Headerless PCM. `pcmToWav` makes it a file. */
  readonly pcm: Uint8Array;
  readonly format: PcmFormat;
  readonly provider: VoiceProviderId;
  readonly model: string;
  /** Characters billed, which is how both vendors price. */
  readonly characters: number;
}

export interface VoiceProvider {
  readonly id: VoiceProviderId;
  readonly model: string;
  speak(request: SpeechRequest): Promise<SpeechResult>;
}

export class VoiceError extends Error {
  readonly provider: VoiceProviderId;
  readonly status: number;

  constructor(options: { provider: VoiceProviderId; status: number; message: string }) {
    super(`${options.provider} TTS: ${options.message}`);
    this.name = 'VoiceError';
    this.provider = options.provider;
    this.status = options.status;
  }
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/**
 * Gemini's audio response, narrowed to what is used.
 *
 * The audio arrives as base64 inside `inlineData`, with `mimeType` naming the sample rate —
 * `audio/L16;codec=pcm;rate=24000`. The rate is parsed from it rather than assumed, because
 * it is the one field that would produce a file that plays at the wrong pitch instead of
 * failing.
 */
const GeminiAudioSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  inlineData: z
                    .object({ mimeType: z.string(), data: z.string() })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
});

/** Sample rate out of `audio/L16;codec=pcm;rate=24000`, falling back to the documented one. */
function rateFromMime(mimeType: string): number {
  const match = /rate=(\d+)/.exec(mimeType);
  if (match?.[1] === undefined) return GEMINI_PCM.sampleRate;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : GEMINI_PCM.sampleRate;
}

export const DEFAULT_VOICE_MODELS: Readonly<Record<VoiceProviderId, string>> = {
  // Queried from the live model list rather than remembered. Two others are available
  // (gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts); this is the current lite tier.
  gemini: 'gemini-3.1-flash-tts-preview',
  sarvam: 'bulbul:v3',
};

/**
 * Gemini's default voices are named rather than numbered.
 *
 * `Kore` is a mid-pitch, level delivery. Chosen because a collections call must not sound
 * cheerful — the warm and bright voices read as a marketing call, which is both wrong in tone
 * and more likely to be hung up on.
 */
const GEMINI_DEFAULT_VOICE = 'Kore';

export function createGeminiVoice(options: {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}): VoiceProvider {
  const model = options.model ?? DEFAULT_VOICE_MODELS.gemini;
  const base = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';

  return {
    id: 'gemini',
    model,

    async speak(request) {
      const response = await fetch(
        `${base}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
          body: JSON.stringify({
            // The script only. No system instruction telling the model how to feel about it:
            // a style directive is a way of changing what the customer hears without changing
            // the registered template, which is the boundary this layer exists to hold.
            contents: [{ role: 'user', parts: [{ text: request.text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: request.voice ?? GEMINI_DEFAULT_VOICE,
                  },
                },
              },
            },
          }),
        },
      ).catch((cause: unknown) => {
        throw new VoiceError({
          provider: 'gemini',
          status: 0,
          message: cause instanceof Error ? cause.message : 'network failure',
        });
      });

      const body: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new VoiceError({
          provider: 'gemini',
          status: response.status,
          message: describe(body, response.status),
        });
      }

      const parsed = GeminiAudioSchema.safeParse(body);
      const part = parsed.success
        ? parsed.data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData !== undefined)
        : undefined;

      if (part?.inlineData === undefined) {
        // A candidate with no audio is usually a safety block or a model that ignored the
        // AUDIO modality. Reported as a failure rather than as an empty file, because a
        // zero-byte WAV in the artifacts directory looks like a successful run.
        const finish = parsed.success
          ? parsed.data.candidates?.[0]?.finishReason ?? 'no audio part'
          : 'unrecognised response shape';
        throw new VoiceError({ provider: 'gemini', status: 200, message: finish });
      }

      return {
        pcm: Buffer.from(part.inlineData.data, 'base64'),
        format: { ...GEMINI_PCM, sampleRate: rateFromMime(part.inlineData.mimeType) },
        provider: 'gemini',
        model,
        characters: request.text.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sarvam
// ---------------------------------------------------------------------------

const SarvamAudioSchema = z.object({
  /** Base64 WAV chunks, one per input segment. */
  audios: z.array(z.string()).min(1),
});

/**
 * Sarvam AI's Bulbul.
 *
 * Built for Indian languages and code-mixed text, which is exactly the Hinglish case, and the
 * reason this adapter exists even though Gemini is already configured: a provider trained on
 * how Indians actually say "dabaayein" gets the prosody right in a way a general multilingual
 * model does not reliably.
 *
 * NOTE ON THE RETURN SHAPE. Sarvam returns base64 **WAV**, not raw PCM — so unlike the Gemini
 * path the header is already present. The 44 bytes are stripped here so both providers hand
 * back the same thing and `pcmToWav` remains the single place a header is written. Trimming
 * on the way in beats special-casing on the way out.
 */
export function createSarvamVoice(options: {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}): VoiceProvider {
  const model = options.model ?? DEFAULT_VOICE_MODELS.sarvam;
  const base = options.baseUrl ?? 'https://api.sarvam.ai';

  return {
    id: 'sarvam',
    model,

    async speak(request) {
      const response = await fetch(`${base}/text-to-speech`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-subscription-key': options.apiKey,
        },
        body: JSON.stringify({
          text: request.text,
          target_language_code: request.language,
          model,
          ...(request.voice === null ? {} : { speaker: request.voice }),
        }),
      }).catch((cause: unknown) => {
        throw new VoiceError({
          provider: 'sarvam',
          status: 0,
          message: cause instanceof Error ? cause.message : 'network failure',
        });
      });

      const body: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new VoiceError({
          provider: 'sarvam',
          status: response.status,
          message: describe(body, response.status),
        });
      }

      const parsed = SarvamAudioSchema.safeParse(body);
      if (!parsed.success) {
        throw new VoiceError({
          provider: 'sarvam',
          status: 200,
          message: 'response carried no audio array',
        });
      }

      // Segments concatenated with each one's header removed. Joining WAV files by
      // concatenation is the classic mistake here: the result plays only the first segment,
      // because every player stops at the first `data` chunk length it read.
      const pcm = Buffer.concat(
        parsed.data.audios.map((chunk) => Buffer.from(chunk, 'base64').subarray(44)),
      );

      return {
        pcm,
        format: SARVAM_PCM,
        provider: 'sarvam',
        model,
        characters: request.text.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Placeholders in `.env.example`. Treated as absent, so a copied file skips cleanly. */
const PLACEHOLDERS = new Set(['', '...', 'change-me', 'your-key-here']);

function usable(value: string | undefined): value is string {
  return value !== undefined && !PLACEHOLDERS.has(value.trim());
}

function describe(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const error = record['error'];
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    if (typeof record['message'] === 'string') return record['message'];
  }
  return `HTTP ${status}`;
}

export interface VoiceResolution {
  readonly provider: VoiceProvider | null;
  readonly problem: string | null;
}

/**
 * Which provider to use, from the environment.
 *
 * SARVAM IS PREFERRED WHEN BOTH KEYS ARE PRESENT, which is the opposite of the classifier's
 * default and deliberate: the classifier's job is language-agnostic and Gemini is priced
 * better for it, while this one is specifically Hinglish and Sarvam is built for it. Naming
 * a provider explicitly with `VOICE_PROVIDER` overrides the preference either way.
 */
export function resolveVoiceProvider(env: NodeJS.ProcessEnv = process.env): VoiceResolution {
  const named = env['VOICE_PROVIDER']?.trim();
  const sarvamKey = env['SARVAM_API_KEY'];
  const geminiKey = env['GEMINI_API_KEY'];

  /*
   * AN EMPTY `VOICE_MODEL` IS ABSENT, NOT A MODEL NAMED "".
   *
   * This read `env['VOICE_MODEL']?.trim()` and spread it in whenever it was not `undefined`.
   * `.env.example` ships `VOICE_MODEL=` with nothing after it, so a copied file — or the one
   * a key was just added to — passed `model: ''` and OVERRODE the default. The CLI printed
   * `sarvam:` with an empty model and the request would have gone out asking for a model
   * that does not exist.
   *
   * Caught by reading the dry-run output after setting a key, which is the only place it was
   * visible: the failure is a request the provider rejects, not a type error. The sibling
   * resolver in `@rc/ai` already collapsed empty to the default; this one did not, and two
   * files by the same hand disagreeing about the same env convention is exactly how that
   * happens.
   */
  const named_model = env['VOICE_MODEL']?.trim() ?? '';
  const pick = (id: VoiceProviderId): { model: string } => ({
    model: named_model === '' ? DEFAULT_VOICE_MODELS[id] : named_model,
  });

  if (named !== undefined && named !== '') {
    if (!(VOICE_PROVIDER_IDS as readonly string[]).includes(named)) {
      return {
        provider: null,
        problem: `VOICE_PROVIDER is "${named}"; expected one of ${VOICE_PROVIDER_IDS.join(', ')}`,
      };
    }
    if (named === 'sarvam') {
      return usable(sarvamKey)
        ? { provider: createSarvamVoice({ apiKey: sarvamKey, ...pick('sarvam') }), problem: null }
        : { provider: null, problem: 'VOICE_PROVIDER=sarvam but SARVAM_API_KEY is not set' };
    }
    return usable(geminiKey)
      ? { provider: createGeminiVoice({ apiKey: geminiKey, ...pick('gemini') }), problem: null }
      : { provider: null, problem: 'VOICE_PROVIDER=gemini but GEMINI_API_KEY is not set' };
  }

  if (usable(sarvamKey)) {
    return { provider: createSarvamVoice({ apiKey: sarvamKey, ...pick('sarvam') }), problem: null };
  }
  if (usable(geminiKey)) {
    return { provider: createGeminiVoice({ apiKey: geminiKey, ...pick('gemini') }), problem: null };
  }

  return {
    provider: null,
    problem:
      'No speech key configured. Set SARVAM_API_KEY (dashboard.sarvam.ai — built for Indian ' +
      'code-mixed speech) or GEMINI_API_KEY (aistudio.google.com/apikey).',
  };
}
