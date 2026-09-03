import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_VOICE_MODELS,
  VoiceError,
  resolveVoiceProvider,
} from './providers.js';
import { ScriptError, languageTagFor, renderScript } from './render.js';
import { durationSeconds, pcmToWav } from './wav.js';

/**
 * `pnpm voice` — render a registered call script to audio.
 *
 * DRY RUN BY DEFAULT, like `pnpm razorpay`. With no key configured it prints the exact script
 * that would be spoken and the exact request that would be sent, so the whole path is
 * inspectable with no credentials and no network. `--speak` is what makes a call.
 *
 * The scripts below are copied from `TEMPLATES` in @rc/simulator rather than imported.
 * @rc/voice depends on @rc/core alone: pulling in the simulator to reach two strings would
 * put a package that holds ground truth into the dependency graph of a package that talks to
 * a third-party API, and `pnpm lint:boundaries` would be right to fail it. A test asserts the
 * two copies stay identical, so the duplication cannot drift silently.
 */

interface Script {
  readonly id: string;
  readonly language: string;
  readonly body: string;
  readonly variables: readonly string[];
}

const SCRIPTS: readonly Script[] = [
  {
    id: 'tpl_ar_voice_final_hi_v1',
    language: 'hi_latn',
    body:
      'Namaste, yeh {{merchant}} ki taraf se automated call hai. Invoice {{invoice}}, rupees ' +
      '{{amount}} ka payment {{days}} din se pending hai. Payment link SMS par chahiye to 1 ' +
      'dabaayein, accounts team se baat karni ho to 2 dabaayein, yeh calls band karne ke liye ' +
      '9 dabaayein.',
    variables: ['merchant', 'invoice', 'amount', 'days'],
  },
  {
    id: 'tpl_ar_voice_final_v1',
    language: 'en',
    body:
      'Hello, this is an automated call from {{merchant}} about invoice {{invoice}} for ' +
      'rupees {{amount}}, which is {{days}} days overdue. Press 1 to receive a payment link ' +
      'by SMS, press 2 to speak to our accounts team, or press 9 to stop these calls.',
    variables: ['merchant', 'invoice', 'amount', 'days'],
  },
];

/**
 * Sample values.
 *
 * Obviously fictional, and that is a rule rather than laziness: a demo artifact that names a
 * plausible real company and a plausible real invoice is a document that can be mistaken for
 * a real one the moment it leaves this repository.
 */
const SAMPLE: Readonly<Record<string, string>> = {
  merchant: 'Devkit Supplies',
  invoice: 'INV-2026-0413',
  amount: 'four lakh twelve thousand',
  days: 'thirty two',
};

function parseArgs(argv: readonly string[]): {
  readonly speak: boolean;
  readonly scriptId: string;
  readonly voice: string | null;
  readonly out: string;
} {
  const flags = new Map<string, string>();
  let speak = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === '--speak') {
      speak = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${token} expects a value`);
    }
    flags.set(token.slice(2), value);
  }

  return {
    speak,
    scriptId: flags.get('script') ?? 'tpl_ar_voice_final_hi_v1',
    voice: flags.get('voice') ?? null,
    out: flags.get('out') ?? 'artifacts',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const script = SCRIPTS.find((entry) => entry.id === args.scriptId);
  if (script === undefined) {
    throw new Error(
      `No script "${args.scriptId}". Available: ${SCRIPTS.map((s) => s.id).join(', ')}`,
    );
  }

  const rendered = renderScript(script, SAMPLE);
  const language = languageTagFor(rendered.language);

  process.stdout.write(
    `\n  Registered call script\n` +
      `  ${rendered.templateId} · ${rendered.language} → ${language}\n\n` +
      `  ${rendered.text.replace(/(.{76}\s)/g, '$1\n  ')}\n\n`,
  );

  const { provider, problem } = resolveVoiceProvider();

  if (!args.speak) {
    process.stdout.write(
      `  DRY RUN. Nothing was synthesised.\n` +
        `  Provider that would be used: ${provider === null ? `none — ${problem ?? ''}` : `${provider.id}:${provider.model}`}\n` +
        `  Add --speak to render audio.\n\n` +
        `  Voices are named, not numbered. Gemini: Kore (default, level), Puck, Charon,\n` +
        `  Fenrir, Aoede. Sarvam: anushka, manisha, vidya, arya, karun, hitesh.\n` +
        `  Pick one with --voice.\n\n`,
    );
    return;
  }

  if (provider === null) {
    throw new Error(problem ?? 'no speech provider configured');
  }

  const started = Date.now();
  const result = await provider.speak({ text: rendered.text, language, voice: args.voice });
  const elapsed = Date.now() - started;

  const wav = pcmToWav(result.pcm, result.format);
  await mkdir(args.out, { recursive: true });
  const path = join(args.out, `${rendered.templateId}.${result.provider}.wav`);
  await writeFile(path, wav);

  process.stdout.write(
    `  ${result.provider}:${result.model} · voice ${args.voice ?? 'default'}\n` +
      `  ${result.characters} characters · ${result.format.sampleRate} Hz mono · ` +
      `${durationSeconds(result.pcm.length, result.format).toFixed(1)}s · ${elapsed} ms\n\n` +
      `  ${path} — ${(wav.length / 1024).toFixed(0)} KB\n\n`,
  );
}

main().catch((cause: unknown) => {
  // A script error is the caller's mistake and a provider error is the vendor's; neither is a
  // crash, and printing a stack for either buries the one line that says what to do.
  if (cause instanceof ScriptError || cause instanceof VoiceError) {
    process.stderr.write(`\n  ${cause.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  if (cause instanceof Error && /^--/.test(cause.message)) {
    process.stderr.write(`\n  ${cause.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    `\n  ${cause instanceof Error ? cause.message : String(cause)}\n` +
      `  Default models: gemini ${DEFAULT_VOICE_MODELS.gemini}, sarvam ${DEFAULT_VOICE_MODELS.sarvam}\n\n`,
  );
  process.exitCode = 1;
});
