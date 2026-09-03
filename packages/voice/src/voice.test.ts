import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOICE_MODELS,
  ScriptError,
  VoiceError,
  createGeminiVoice,
  createSarvamVoice,
  languageTagFor,
  renderScript,
  resolveVoiceProvider,
} from './index.js';
import { GEMINI_PCM, durationSeconds, pcmToWav } from './wav.js';

/**
 * The voice path, without a network and without a key.
 *
 * What is asserted is the part that actually goes wrong: whether the file is playable, and
 * whether anything unapproved can reach a customer's ear.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const SCRIPT = {
  id: 'tpl_test_v1',
  language: 'hi_latn',
  body: 'Namaste {{name}}, {{amount}} rupees pending hai. 1 dabaayein.',
  variables: ['name', 'amount'],
};

describe('a registered script, filled and nothing more', () => {
  it('substitutes declared variables', () => {
    const out = renderScript(SCRIPT, { name: 'Asha', amount: 'four hundred' });
    expect(out.text).toBe('Namaste Asha, four hundred rupees pending hai. 1 dabaayein.');
    expect(out.templateId).toBe('tpl_test_v1');
  });

  it('refuses a variable the template never declared', () => {
    // The caller and the template disagree about the script. The quiet outcome is a value
    // silently dropped, and on a voice call nobody finds out.
    expect(() =>
      renderScript(SCRIPT, { name: 'Asha', amount: '400', link: 'https://x.test' }),
    ).toThrow(ScriptError);
  });

  it('refuses to speak "rupees undefined"', () => {
    expect(() => renderScript(SCRIPT, { name: 'Asha' })).toThrow(/needs "amount"/);
  });

  it('catches a typo in the TEMPLATE, and blames the template', () => {
    // `{{ammount}}` is declared nowhere, so every correct call would still leave it in the
    // text — and a synthesiser reads it aloud, braces and all.
    const typo = { ...SCRIPT, body: 'Namaste {{name}}, {{ammount}} rupees pending hai.' };
    expect(() => renderScript(typo, { name: 'Asha', amount: '400' })).toThrow(
      /references "ammount", which it does not declare/,
    );
  });

  it('catches a MALFORMED placeholder, which the substitution pattern cannot match', () => {
    // `{{ amount }}` has spaces, so `{{w+}}` never sees it and the replacer never runs.
    // Only the leftover sweep catches this one, and it must blame the template rather than
    // the caller — no value could fill it.
    const spaced = { ...SCRIPT, body: 'Namaste {{name}}, {{ amount }} rupees pending hai.' };
    expect(() => renderScript(spaced, { name: 'Asha', amount: '400' })).toThrow(/malformed/);
  });

  it('refuses a VALUE that carries a placeholder of its own', () => {
    // A brace sequence in a value is either a bug or an attempt to introduce a directive
    // into an approved script. Refused up front, which is also what keeps the leftover
    // check unambiguous: with values cleared, a leftover can only be the template's fault.
    expect(() => renderScript(SCRIPT, { name: '{{amount}}', amount: 'four hundred' })).toThrow(
      /may not/,
    );
  });

  it('maps Hinglish to Hindi phonology, not to Indian English', () => {
    // The text is Latin script and the target is Hindi pronunciation. `en-IN` makes a
    // synthesiser read "dabaayein" with English vowels, which is worse than either language
    // spoken properly.
    expect(languageTagFor('hi_latn')).toBe('hi-IN');
    expect(languageTagFor('en')).toBe('en-IN');
  });
});

describe('the script the CLI speaks is the one the engine registered', () => {
  it('matches @rc/simulator character for character', () => {
    // @rc/voice depends on @rc/core alone, so the two Hinglish scripts are DUPLICATED in
    // `cli.ts` rather than imported — pulling in the simulator to reach two strings would put
    // the package that holds ground truth into the dependency graph of the package that
    // talks to a third-party API, and `pnpm lint:boundaries` would be right to fail it.
    //
    // This is the test that keeps the duplication honest. Read as TEXT rather than imported,
    // for the same reason: importing @rc/simulator here would create exactly the edge the
    // duplication exists to avoid, and a test file is inside the boundary graph.
    const root = join(import.meta.dirname, '..', '..', '..');
    const templates = readFileSync(join(root, 'packages/simulator/src/templates.ts'), 'utf8');
    const cli = readFileSync(join(root, 'packages/voice/src/cli.ts'), 'utf8');

    for (const id of ['tpl_ar_voice_final_hi_v1', 'tpl_ar_voice_final_v1']) {
      const fromTemplates = bodyOf(templates, id);
      const fromCli = bodyOf(cli, id);
      expect(fromCli, `${id} has drifted from the registered template`).toBe(fromTemplates);
    }
  });
});

/** The `body:` string of one template id, with concatenation and whitespace normalised. */
function bodyOf(source: string, id: string): string {
  const start = source.indexOf(`id: '${id}'`);
  if (start === -1) throw new Error(`${id} not found`);

  const bodyAt = source.indexOf('body:', start);
  const variablesAt = source.indexOf('variables:', bodyAt);
  if (bodyAt === -1 || variablesAt === -1) throw new Error(`${id} has no body/variables`);

  return source
    .slice(bodyAt + 'body:'.length, variablesAt)
    .replace(/'\s*\+\s*'/g, '')
    .replace(/[',]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the file is playable', () => {
  const pcm = new Uint8Array(480); // 10 ms at 24 kHz mono 16-bit

  it('writes a canonical 44-byte RIFF header', () => {
    const wav = pcmToWav(pcm, GEMINI_PCM);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (at: number): string =>
      String.fromCharCode(...Array.from(wav.subarray(at, at + 4)));

    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(ascii(12)).toBe('fmt ');
    expect(ascii(36)).toBe('data');

    expect(view.getUint16(20, true)).toBe(1); // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('declares a RIFF size that excludes its own field, which is the classic off-by-eight', () => {
    // `pcm.length + 36`, not + 44: the field counts everything AFTER itself, so it omits
    // both "RIFF" and the four bytes of the size. Get it wrong and strict players truncate.
    const wav = pcmToWav(pcm, GEMINI_PCM);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(40, true)).toBe(pcm.length);
  });

  it('derives byte rate and block align from the format rather than hardcoding them', () => {
    const wav = pcmToWav(pcm, { sampleRate: 22_050, channels: 2, bitsPerSample: 16 });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(32, true)).toBe(4); // 2 channels × 2 bytes
    expect(view.getUint32(28, true)).toBe(22_050 * 4);
  });

  it('refuses a format that would produce a file playing at the wrong pitch', () => {
    expect(() => pcmToWav(pcm, { ...GEMINI_PCM, sampleRate: 0 })).toThrow(/positive/);
    expect(() => pcmToWav(pcm, { ...GEMINI_PCM, bitsPerSample: 12 })).toThrow(/multiple of 8/);
  });

  it('reports duration from byte count', () => {
    expect(durationSeconds(48_000, GEMINI_PCM)).toBeCloseTo(1, 5);
  });
});

describe('Gemini speech', () => {
  const provider = createGeminiVoice({
    apiKey: 'k',
    model: 'gemini-3.1-flash-tts-preview',
    baseUrl: 'https://gemini.test/v1beta',
  });

  const request = { text: 'Namaste', language: 'hi-IN', voice: null };

  it('reads the sample rate off the mime type rather than assuming it', () => {
    // THE FIELD THAT FAILS QUIETLY. A wrong rate does not error — it produces a file that
    // plays at the wrong pitch, which sounds like a bad synthesiser rather than a bug.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'audio/L16;codec=pcm;rate=16000',
                          data: Buffer.from(new Uint8Array(320)).toString('base64'),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          ),
        ),
      ),
    );

    return provider.speak(request).then((result) => {
      expect(result.format.sampleRate).toBe(16_000);
      expect(result.pcm.length).toBe(320);
    });
  });

  it('reports a candidate with no audio as a failure, not as an empty file', async () => {
    // A zero-byte WAV in the artifacts directory looks like a successful run.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] })),
        ),
      ),
    );

    await expect(provider.speak(request)).rejects.toThrow(/SAFETY/);
  });

  it('surfaces an auth failure with the provider named', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'API key not valid' } }), {
            status: 401,
          }),
        ),
      ),
    );

    await expect(provider.speak(request)).rejects.toMatchObject({
      provider: 'gemini',
      status: 401,
    });
  });
});

describe('Sarvam speech', () => {
  const provider = createSarvamVoice({ apiKey: 'k', baseUrl: 'https://sarvam.test' });

  it('strips each segment header before concatenating, or only the first plays', async () => {
    // THE MISTAKE THIS GUARDS. Sarvam returns base64 WAV per segment, and concatenating whole
    // WAV files produces audio that stops after the first one — every player trusts the
    // `data` length it read in the first header.
    const segment = (bytes: number): string => {
      const pcm = new Uint8Array(bytes).fill(7);
      return Buffer.from(pcmToWav(pcm, { sampleRate: 22_050, channels: 1, bitsPerSample: 16 }))
        .toString('base64');
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ audios: [segment(100), segment(60)] }))),
      ),
    );

    const result = await provider.speak({ text: 'x', language: 'hi-IN', voice: null });
    // 160 bytes of payload, not 160 + two 44-byte headers.
    expect(result.pcm.length).toBe(160);
    expect(Array.from(result.pcm).every((byte) => byte === 7)).toBe(true);
  });

  it('reports a response with no audio array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true })))),
    );

    await expect(
      provider.speak({ text: 'x', language: 'hi-IN', voice: null }),
    ).rejects.toThrow(VoiceError);
  });
});

describe('provider selection', () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

  it('prefers Sarvam when both keys are present', () => {
    // The OPPOSITE of the classifier's default, and deliberate: that job is
    // language-agnostic, this one is specifically Hinglish, and Bulbul is built for Indian
    // code-mixed speech.
    expect(
      resolveVoiceProvider(env({ SARVAM_API_KEY: 'a', GEMINI_API_KEY: 'b' })).provider?.id,
    ).toBe('sarvam');
  });

  it('falls back to whichever key exists', () => {
    expect(resolveVoiceProvider(env({ GEMINI_API_KEY: 'b' })).provider?.id).toBe('gemini');
  });

  it('honours an explicit choice, and says so when its key is missing', () => {
    expect(
      resolveVoiceProvider(env({ VOICE_PROVIDER: 'gemini', GEMINI_API_KEY: 'b' })).provider?.id,
    ).toBe('gemini');

    const { provider, problem } = resolveVoiceProvider(
      env({ VOICE_PROVIDER: 'sarvam', GEMINI_API_KEY: 'b' }),
    );
    expect(provider).toBeNull();
    expect(problem).toMatch(/SARVAM_API_KEY/);
  });

  it('treats a placeholder key as absent', () => {
    // `.env.example` ships `SARVAM_API_KEY=...`, and a copied example file is the most common
    // reason a run fails on authentication rather than reporting that nothing is configured.
    const { provider, problem } = resolveVoiceProvider(env({ SARVAM_API_KEY: '...' }));
    expect(provider).toBeNull();
    expect(problem).toMatch(/No speech key/);
  });

  it('rejects an unknown provider name instead of silently picking one', () => {
    const { problem } = resolveVoiceProvider(
      env({ VOICE_PROVIDER: 'elevenlabs', GEMINI_API_KEY: 'b' }),
    );
    expect(problem).toMatch(/expected one of/);
  });
});

describe('an empty env var is absent, not a value', () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

  it('does not let VOICE_MODEL="" override the default', () => {
    // THE BUG THIS PINS. `.env.example` ships `VOICE_MODEL=` with nothing after it, and the
    // resolver spread the value in whenever it was not `undefined` — so a copied file passed
    // `model: ''` and the CLI printed `sarvam:` with no model. The request would then have
    // asked a provider for a model that does not exist, which is a rejected call rather than
    // a type error, so nothing upstream would have caught it.
    const { provider } = resolveVoiceProvider(
      env({ SARVAM_API_KEY: 'k', VOICE_MODEL: '' }),
    );
    expect(provider?.model).toBe(DEFAULT_VOICE_MODELS.sarvam);
  });

  it('does not let VOICE_PROVIDER="" defeat the preference order', () => {
    // Same class of mistake on the sibling variable: an empty provider name must fall
    // through to "whichever key is present" rather than fail an unknown-name check.
    const { provider, problem } = resolveVoiceProvider(
      env({ VOICE_PROVIDER: '', SARVAM_API_KEY: 'k', GEMINI_API_KEY: 'k' }),
    );
    expect(problem).toBeNull();
    expect(provider?.id).toBe('sarvam');
  });

  it('still honours a real VOICE_MODEL', () => {
    const { provider } = resolveVoiceProvider(
      env({ SARVAM_API_KEY: 'k', VOICE_MODEL: 'bulbul:v1' }),
    );
    expect(provider?.model).toBe('bulbul:v1');
  });

  it('applies the default per provider, not one shared string', () => {
    expect(resolveVoiceProvider(env({ SARVAM_API_KEY: 'k' })).provider?.model).toBe(
      DEFAULT_VOICE_MODELS.sarvam,
    );
    expect(resolveVoiceProvider(env({ GEMINI_API_KEY: 'k' })).provider?.model).toBe(
      DEFAULT_VOICE_MODELS.gemini,
    );
  });
});
