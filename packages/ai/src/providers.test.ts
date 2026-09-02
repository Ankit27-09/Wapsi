import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  createGeminiProvider,
  createGroqProvider,
  readJson,
  resolveProvider,
} from './providers.js';
import { classificationSystemPrompt } from './llm.js';

/**
 * The provider layer, without a network or a key.
 *
 * `fetch` is stubbed rather than hit. A test that called a real provider would need live
 * keys, would be rate-limited, would fail offline, and would bill somebody every time the
 * suite ran — and none of that would test anything these do not.
 *
 * What is asserted is the part that actually goes wrong when swapping vendors: token
 * accounting, the shape of a response, and whether a failure arrives as something a report
 * can group by.
 */

const gemini = createGeminiProvider({
  apiKey: 'test-key',
  model: 'gemini-2.5-flash',
  baseUrl: 'https://gemini.test/v1beta',
});

const groq = createGroqProvider({
  apiKey: 'test-key',
  model: 'llama-3.3-70b-versatile',
  baseUrl: 'https://groq.test/openai/v1',
});

const call = {
  systemPrompt: 'you classify things',
  userMessage: 'classify this',
  maxTokens: 256,
};

/** A fresh Response per call. The body can only be read once. */
function reply(body: unknown, status = 200): () => Promise<Response> {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gemini token accounting', () => {
  it('subtracts cached tokens out of the prompt count', async () => {
    // THE ONE THAT WOULD SILENTLY DOUBLE THE BILL. Gemini's `promptTokenCount` INCLUDES
    // cached tokens, and the cost model prices cached reads at a tenth of the input rate —
    // so passing the raw figure through would charge the cached prefix at full rate on every
    // call while also counting it as cached.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        reply({
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 40,
            cachedContentTokenCount: 900,
          },
        }),
      ),
    );

    const result = await gemini.complete(call);

    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.cacheReadTokens).toBe(900);
    expect(result.usage.outputTokens).toBe(40);
  });

  it('never reports a negative input count', async () => {
    // If a future response reported more cached tokens than prompt tokens, the subtraction
    // above would go negative and the cost model would credit money back.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        reply({
          candidates: [{ content: { parts: [{ text: '{}' }] } }],
          usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 900 },
        }),
      ),
    );

    const result = await gemini.complete(call);
    expect(result.usage.inputTokens).toBe(0);
  });

  it('joins multi-part responses rather than taking the first part', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        reply({
          candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }],
        }),
      ),
    );

    const result = await gemini.complete(call);
    expect(result.text).toBe('{"a":1}');
  });

  it('reports a blocked or truncated candidate as a provider failure, with the reason', async () => {
    // A candidate with no text is usually a safety block or a token cap hit mid-object.
    // Returning it as an empty string would land in the report as "the model could not
    // classify" — a different and misleading fact.
    vi.stubGlobal(
      'fetch',
      vi.fn(reply({ candidates: [{ finishReason: 'SAFETY' }] })),
    );

    await expect(gemini.complete(call)).rejects.toThrow(/SAFETY/);
  });
});

describe('Groq', () => {
  it('reads the OpenAI-shaped usage fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        reply({
          choices: [{ message: { content: '{"ok":1}' } }],
          usage: { prompt_tokens: 820, completion_tokens: 25 },
        }),
      ),
    );

    const result = await groq.complete(call);

    expect(result.usage.inputTokens).toBe(820);
    expect(result.usage.outputTokens).toBe(25);
    // Groq does not report prompt caching on this endpoint, so this is honestly zero
    // rather than optimistically assumed.
    expect(result.usage.cacheReadTokens).toBe(0);
  });

  it('sends the word JSON in the prompt, which json_object mode requires', () => {
    // Groq returns a 400 if `response_format: json_object` is requested and the prompt does
    // not mention JSON. That is a run-time failure on every call rather than a compile
    // error, so it is pinned here — the prompt is shared with the other provider and
    // somebody rewording it would not think to check Groq's requirement.
    expect(classificationSystemPrompt()).toMatch(/JSON/);
  });

  it('reports an empty completion with its finish reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(reply({ choices: [{ message: { content: null }, finish_reason: 'length' }] })),
    );

    await expect(groq.complete(call)).rejects.toThrow(/length/);
  });
});

describe('failures arrive as something a report can group by', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [400, 'bad_request'],
    [503, 'server'],
  ])('maps HTTP %i to kind %s', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn(reply({ error: { message: 'nope' } }, status)));

    await expect(groq.complete(call)).rejects.toMatchObject({ kind, status });
  });

  it('maps an unreachable host to a network failure, not a TypeError', async () => {
    // What actually happens on a flaky connection. `TypeError: fetch failed` in a report
    // tells an operator nothing about which provider or why.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ENOTFOUND'))));

    const error = await gemini.complete(call).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'network', provider: 'gemini' });
  });

  it('maps a response this client does not recognise to a shape failure', async () => {
    vi.stubGlobal('fetch', vi.fn(reply({ unexpected: true })));

    await expect(groq.complete(call)).rejects.toMatchObject({ kind: 'shape' });
  });
});

describe('reading JSON out of a completion', () => {
  it('accepts a clean object', () => {
    expect(readJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers an object wrapped in a code fence', () => {
    // Both providers honour JSON mode most of the time. A model that fences its answer is a
    // recoverable failure, and discarding the whole response over three backticks would
    // quarantine a transaction that was correctly classified.
    expect(readJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers an object after a preamble', () => {
    expect(readJson('Sure! Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });

  it('returns something a schema will reject rather than throwing', () => {
    // The caller is inside a batch. Throwing here would abort a run over one malformed
    // string, where quarantining that transaction is the correct and already-built path.
    const result = readJson('not json at all');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('raw');
  });
});

describe('provider selection', () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

  it('uses the provider named by LLM_PROVIDER', () => {
    const { provider } = resolveProvider(
      env({ LLM_PROVIDER: 'groq', GROQ_API_KEY: 'k', GEMINI_API_KEY: 'k' }),
    );
    expect(provider?.id).toBe('groq');
  });

  it('falls back to whichever key is present', () => {
    expect(resolveProvider(env({ GROQ_API_KEY: 'k' })).provider?.id).toBe('groq');
    expect(resolveProvider(env({ GEMINI_API_KEY: 'k' })).provider?.id).toBe('gemini');
  });

  it('treats a placeholder key as absent', () => {
    // `.env.example` ships `GEMINI_API_KEY=...`, and a copied example file is the most
    // common reason a run fails on authentication three minutes in rather than skipping
    // the arm immediately.
    const { provider, problem } = resolveProvider(env({ GEMINI_API_KEY: '...' }));
    expect(provider).toBeNull();
    expect(problem).toMatch(/No model key/);
  });

  it('explains itself when nothing is configured, with where to get a key', () => {
    const { provider, problem } = resolveProvider(env({}));
    expect(provider).toBeNull();
    expect(problem).toMatch(/aistudio\.google\.com|console\.groq\.com/);
  });

  it('rejects an unknown provider name instead of silently picking one', () => {
    const { provider, problem } = resolveProvider(
      env({ LLM_PROVIDER: 'openai', GROQ_API_KEY: 'k' }),
    );
    expect(provider).toBeNull();
    expect(problem).toMatch(/expected one of/);
  });

  it('honours LLM_MODEL over the default', () => {
    const { provider } = resolveProvider(
      env({ GROQ_API_KEY: 'k', LLM_MODEL: 'llama-3.1-8b-instant' }),
    );
    expect(provider?.model).toBe('llama-3.1-8b-instant');
  });
});
