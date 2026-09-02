import { z } from 'zod';

/**
 * MODEL PROVIDERS
 *
 * One narrow contract — send a system prompt and a user message, get JSON text and a token
 * count back — with an implementation per vendor behind it.
 *
 * WHY A LAYER RATHER THAN A SECOND CLASSIFIER.
 *
 * Everything that makes the classification path safe is provider-independent: the system
 * prompt, its hash, the Zod enum the output is validated against, the confidence floor, and
 * the quarantine path for anything that fails. Writing a second classifier per vendor would
 * duplicate all of that and let the copies drift — and the copy that drifted would be the one
 * where a model output stopped being checked against the taxonomy.
 *
 * So the vendor-specific part is reduced to what it actually is: an HTTP shape and a usage
 * field naming convention.
 *
 * RAW `fetch`, NOT VENDOR SDKS. Two methods are needed and both are plain REST. Against that,
 * each SDK is a dependency to keep current whose types describe rather than enforce the
 * response — and this codebase validates at every boundary rather than trusting one. A
 * renamed usage field then throws with the field named instead of silently reporting zero
 * tokens and zero cost.
 */

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export const PROVIDER_IDS = ['gemini', 'groq'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderCall {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly maxTokens: number;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Tokens served from a prompt cache, billed at a fraction of the input rate.
   *
   * Zero on providers that do not report it. Reported separately rather than folded into
   * `inputTokens` because the cost model prices them differently, and a cache that silently
   * stopped working would otherwise be invisible — the total would look identical while the
   * bill tripled.
   */
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ProviderResult {
  /** The raw JSON text the model produced. Parsed and validated by the caller, not here. */
  readonly text: string;
  readonly usage: ProviderUsage;
}

export interface Provider {
  readonly id: ProviderId;
  readonly model: string;
  complete(call: ProviderCall): Promise<ProviderResult>;
}

/** A provider failure, carrying enough to tell a bad key from a rate limit in the report. */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status: number;
  readonly kind: 'auth' | 'rate_limit' | 'bad_request' | 'server' | 'network' | 'shape';

  constructor(args: {
    readonly provider: ProviderId;
    readonly status: number;
    readonly kind: ProviderError['kind'];
    readonly message: string;
  }) {
    super(`${args.provider} ${args.kind}${args.status > 0 ? ` (${args.status})` : ''}: ${args.message}`);
    this.name = 'ProviderError';
    this.provider = args.provider;
    this.status = args.status;
    this.kind = args.kind;
  }
}

const TIMEOUT_MS = 30_000;

/** Map an HTTP status onto something a report can group by. */
function kindFor(status: number): ProviderError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
}

async function postJson(
  provider: ProviderId,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    throw new ProviderError({
      provider,
      status: 0,
      kind: 'network',
      message: aborted
        ? `no response within ${TIMEOUT_MS}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause),
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new ProviderError({
      provider,
      status: response.status,
      kind: kindFor(response.status),
      message: text.slice(0, 300),
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError({
      provider,
      status: response.status,
      kind: 'shape',
      message: `response was not JSON: ${text.slice(0, 200)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/**
 * Only the fields this system reads, and `passthrough` because a vendor adding a field is
 * not an error. A missing one we depend on is, and that is what this catches.
 */
const GeminiResponseSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({ parts: z.array(z.object({ text: z.string() }).passthrough()) })
              .passthrough()
              .optional(),
            finishReason: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usageMetadata: z
      .object({
        promptTokenCount: z.number().int().nonnegative().optional(),
        candidatesTokenCount: z.number().int().nonnegative().optional(),
        cachedContentTokenCount: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function createGeminiProvider(options: {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}): Provider {
  const base = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';

  return {
    id: 'gemini',
    model: options.model,

    async complete(call) {
      const raw = await postJson(
        'gemini',
        `${base}/models/${encodeURIComponent(options.model)}:generateContent`,
        { 'x-goog-api-key': options.apiKey },
        {
          systemInstruction: { parts: [{ text: call.systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: call.userMessage }] }],
          generationConfig: {
            // JSON mode, but deliberately WITHOUT `responseSchema`.
            //
            // Gemini's schema dialect is an OpenAPI subset that has varied across model
            // versions in how it expresses a string enum — so pinning one would make this
            // integration break on a model upgrade for no gain. The guarantee that matters
            // is not that the server constrained the output; it is that WE validate what
            // arrived against the taxonomy, which happens in `llm.ts` regardless of
            // provider. The schema is described in the prompt instead.
            responseMimeType: 'application/json',
            // Deterministic. A classification is a mapping task, and two runs of one seed
            // producing different labels would break the reproducibility claim the whole
            // evaluation rests on.
            temperature: 0,
            maxOutputTokens: call.maxTokens,
          },
        },
      );

      const parsed = GeminiResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ProviderError({
          provider: 'gemini',
          status: 200,
          kind: 'shape',
          message: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
            .join('; '),
        });
      }

      const candidate = parsed.data.candidates[0];
      const text = candidate?.content?.parts.map((part) => part.text).join('') ?? '';

      if (text === '') {
        // A candidate with no text is usually a safety block or a token cap hit mid-object.
        // Surfaced with the reason rather than returned as empty, so it lands in the report
        // as a provider failure instead of a model that could not classify.
        throw new ProviderError({
          provider: 'gemini',
          status: 200,
          kind: 'shape',
          message: `no text in candidate (finishReason: ${candidate?.finishReason ?? 'unknown'})`,
        });
      }

      const usage = parsed.data.usageMetadata;
      const cached = usage?.cachedContentTokenCount ?? 0;

      return {
        text,
        usage: {
          // Gemini's `promptTokenCount` INCLUDES cached tokens, where the cost model wants
          // them separate — so the cached portion is subtracted out. Getting this backwards
          // would double-count the prefix on every call.
          inputTokens: Math.max(0, (usage?.promptTokenCount ?? 0) - cached),
          outputTokens: usage?.candidatesTokenCount ?? 0,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Groq
// ---------------------------------------------------------------------------

const GroqResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().nullable() }).passthrough(),
            finish_reason: z.string().nullish(),
          })
          .passthrough(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function createGroqProvider(options: {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}): Provider {
  const base = options.baseUrl ?? 'https://api.groq.com/openai/v1';

  return {
    id: 'groq',
    model: options.model,

    async complete(call) {
      const raw = await postJson(
        'groq',
        `${base}/chat/completions`,
        { Authorization: `Bearer ${options.apiKey}` },
        {
          model: options.model,
          messages: [
            { role: 'system', content: call.systemPrompt },
            { role: 'user', content: call.userMessage },
          ],
          // OpenAI-compatible JSON mode. Groq requires the word "JSON" to appear in the
          // prompt for this to be accepted, which the shared system prompt satisfies — and a
          // test asserts that, because the failure is a 400 at run time rather than a
          // compile error.
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: call.maxTokens,
        },
      );

      const parsed = GroqResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ProviderError({
          provider: 'groq',
          status: 200,
          kind: 'shape',
          message: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
            .join('; '),
        });
      }

      const choice = parsed.data.choices[0];
      const text = choice?.message.content ?? '';

      if (text === '') {
        throw new ProviderError({
          provider: 'groq',
          status: 200,
          kind: 'shape',
          message: `empty completion (finish_reason: ${choice?.finish_reason ?? 'unknown'})`,
        });
      }

      return {
        text,
        usage: {
          inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.data.usage?.completion_tokens ?? 0,
          // Groq does not report prompt caching on the chat completions endpoint, so this is
          // honestly zero rather than optimistically assumed.
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Default models, chosen for the job rather than for capability.
 *
 * Classification here is a mechanical mapping task: read a short string, return one of
 * eighteen enum values and a confidence. A frontier model is not the right tool and the
 * ablation exists to prove it in rupees — so the defaults are the fast, cheap tiers, and the
 * expensive option is something a reader can configure and measure for themselves.
 */
export const DEFAULT_MODELS: Readonly<Record<ProviderId, string>> = {
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
};

const ENV_KEYS: Readonly<Record<ProviderId, string>> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
};

export interface ProviderResolution {
  readonly provider: Provider | null;
  /** Why no provider could be built. Null when one was. */
  readonly problem: string | null;
}

/**
 * Build the configured provider, or explain why not.
 *
 * A result rather than a throw, because every caller has something useful to do when no key
 * is present: skip the model arm with a clear message and report the free keyword arm on its
 * own. That keeps a plain `pnpm ablate` meaningful for someone who has cloned the repository
 * and has no accounts.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ProviderResolution {
  const requested = env['LLM_PROVIDER']?.trim().toLowerCase();

  if (requested !== undefined && requested !== '') {
    if (!PROVIDER_IDS.includes(requested as ProviderId)) {
      return {
        provider: null,
        problem: `LLM_PROVIDER is "${requested}"; expected one of ${PROVIDER_IDS.join(', ')}`,
      };
    }
    return build(requested as ProviderId, env);
  }

  // No explicit choice: take the first provider with a usable key, in declaration order.
  for (const id of PROVIDER_IDS) {
    if (usableKey(env[ENV_KEYS[id]]) !== null) return build(id, env);
  }

  return {
    provider: null,
    problem:
      `No model key found. Set one of ${PROVIDER_IDS.map((id) => ENV_KEYS[id]).join(' or ')} ` +
      `in .env. Both have free tiers: aistudio.google.com/apikey and console.groq.com/keys`,
  };
}

function build(id: ProviderId, env: NodeJS.ProcessEnv): ProviderResolution {
  const key = usableKey(env[ENV_KEYS[id]]);
  if (key === null) {
    return { provider: null, problem: `${ENV_KEYS[id]} is missing or still a placeholder` };
  }

  const model = env['LLM_MODEL']?.trim() ?? '';
  const chosen = model === '' ? DEFAULT_MODELS[id] : model;

  const provider =
    id === 'gemini'
      ? createGeminiProvider({ apiKey: key, model: chosen })
      : createGroqProvider({ apiKey: key, model: chosen });

  return { provider, problem: null };
}

/**
 * Pull the JSON object out of a completion.
 *
 * JSON mode is requested from both providers and mostly honoured, but a model that wraps its
 * answer in a code fence or prefaces it with a sentence is a real and recoverable failure —
 * so the first balanced object in the text is tried as well as the whole string.
 *
 * On total failure this returns a shape that will fail whatever Zod schema the caller applies,
 * which puts the transaction on the quarantine path with the reason attached rather than
 * throwing mid-batch. Lives here rather than in the classifier because both the classifier
 * and the proposer parse provider output, and two copies of this would eventually differ in
 * how forgiving they were.
 */
export function readJson(text: string): unknown {
  const trimmed = text.trim();
  const attempts = [trimmed];

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return { raw: trimmed.slice(0, 200) };
}

/**
 * A key that is actually usable.
 *
 * `.env.example` ships placeholders ending in `...`, and a copied example file is the most
 * common reason a run fails with an authentication error three minutes in rather than
 * immediately.
 */
function usableKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.endsWith('...')) return null;
  return trimmed;
}
