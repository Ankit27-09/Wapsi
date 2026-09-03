import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ADVISED_WAIT_MS,
  ProviderError,
  createGeminiProvider,
  createGroqProvider,
  readJson,
  resolveProvider,
  retryDelayMs,
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

/**
 * No wait between retries. The real schedule climbs to 15s over six attempts to survive a
 * free tier, and sitting through it to assert on an error kind cost this file 73 seconds.
 * The schedule itself is asserted separately, below.
 */
const noWait = (): number => 0;

const gemini = createGeminiProvider({
  apiKey: 'test-key',
  model: 'gemini-3.1-flash-lite',
  baseUrl: 'https://gemini.test/v1beta',
  retryDelay: noWait,
});

const groq = createGroqProvider({
  apiKey: 'test-key',
  model: 'openai/gpt-oss-20b',
  baseUrl: 'https://groq.test/openai/v1',
  retryDelay: noWait,
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

  it('counts reasoning tokens as output, because they bill at the output rate', async () => {
    // MEASURED ON A LIVE CALL, not hypothesised. A `gemini-3.6-flash` classification
    // reported 58 prompt and 33 candidate tokens against a TOTAL of 276 — the missing 185
    // were thoughts, which are billed and are NOT inside `candidatesTokenCount`.
    //
    // Reading only the candidate count under-reported that call's output cost by 85%. The
    // ablation's whole purpose is to say what the model costs in rupees, so a systematic
    // 85% understatement there would have been a fabricated headline.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        reply({
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          usageMetadata: {
            promptTokenCount: 58,
            candidatesTokenCount: 33,
            thoughtsTokenCount: 185,
          },
        }),
      ),
    );

    const result = await gemini.complete(call);
    expect(result.usage.outputTokens).toBe(218);
    expect(result.usage.inputTokens).toBe(58);
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

  it('does NOT add reasoning tokens, because Groq already includes them', async () => {
    // THE TWO PROVIDERS DISAGREE ABOUT THIS, which is the whole reason a shared usage type
    // beats a per-vendor guess. Verified live: `openai/gpt-oss-20b` reported 158 prompt and
    // 130 completion against a total of 288, with `reasoning_tokens: 95` — so the 95 are
    // INSIDE the 130. Adding them, as the Gemini path correctly must, would double-count.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        reply({
          choices: [{ message: { content: '{"ok":1}' } }],
          usage: {
            prompt_tokens: 158,
            completion_tokens: 130,
            total_tokens: 288,
            completion_tokens_details: { reasoning_tokens: 95 },
          },
        }),
      ),
    );

    const result = await groq.complete(call);
    expect(result.usage.outputTokens).toBe(130);
    // The invariant that makes it checkable: prompt + completion accounts for the total.
    expect(result.usage.inputTokens + result.usage.outputTokens).toBe(288);
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

describe('retrying a throttled call', () => {
  /** A queue of replies, one per call, so attempt counts are observable. */
  function replies(...bodies: readonly (readonly [unknown, number])[]): ReturnType<typeof vi.fn> {
    let i = 0;
    return vi.fn(() => {
      const next = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      const [body, status] = next ?? [{}, 200];
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    });
  }

  const ok: readonly [unknown, number] = [
    { choices: [{ message: { content: '{"ok":1}' } }] },
    200,
  ];
  const throttled: readonly [unknown, number] = [{ error: { message: 'slow down' } }, 429];

  it('recovers when a rate limit clears', async () => {
    // WHY THIS EXISTS AT ALL. On free tiers the first live ablation lost 19 of 40 Gemini
    // calls and 13 of 40 Groq calls to 429s, and the report then showed both models level
    // with a keyword table. Once the calls actually landed, the Gemini arm captured 97.8%
    // of the legal ceiling against the baseline's 26.5%. The retry is the difference
    // between measuring a classifier and measuring a quota.
    const fetchMock = replies(throttled, throttled, ok);
    vi.stubGlobal('fetch', fetchMock);

    const result = await groq.complete(call);

    expect(result.text).toBe('{"ok":1}');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a bad request, which would fail identically every time', async () => {
    const fetchMock = replies([{ error: { message: 'malformed' } }, 400]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(groq.complete(call)).rejects.toMatchObject({ kind: 'bad_request' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of attempts rather than looping', async () => {
    // A provider that is down for the day must not hang a batch forever.
    const fetchMock = replies(throttled);
    vi.stubGlobal('fetch', fetchMock);

    await expect(groq.complete(call)).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('reads Retry-After off a 429 rather than guessing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '3' } })),
      ),
    );

    await expect(groq.complete(call)).rejects.toMatchObject({ retryAfterMs: 3000 });
  });
});

describe('the retry delay policy', () => {
  // Asserted on the pure function, so these cost no wall-clock at all.
  it("prefers the provider's own advice, which knows the quota window", () => {
    expect(retryDelayMs(0, 4_000)).toBe(4_000);
  });

  it('caps that advice, so one header cannot stall a queued batch', () => {
    // A provider asking for two minutes is within its rights and would still be the wrong
    // thing to obey with several hundred transactions waiting behind the call.
    expect(retryDelayMs(0, 120_000)).toBe(MAX_ADVISED_WAIT_MS);
  });

  it('climbs, and then stops climbing', () => {
    const waits = [0, 1, 2, 3, 4, 5].map((n) => retryDelayMs(n, null));

    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
    }
    // Jitter is added on top of the ceiling to desynchronise parallel workers, so the
    // bound is the ceiling plus that, not the ceiling exactly.
    expect(Math.max(...waits)).toBeLessThan(16_000);
  });

  it('never returns the same wait twice, so parallel workers do not retry in lockstep', () => {
    // Without jitter, N workers throttled by the same window all come back at the same
    // instant and are all throttled again. This is why 8-way concurrency lost half its
    // calls on a free tier.
    const sample = new Set(Array.from({ length: 24 }, () => retryDelayMs(3, null)));
    expect(sample.size).toBeGreaterThan(1);
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
      env({ GROQ_API_KEY: 'k', LLM_MODEL: 'openai/gpt-oss-120b' }),
    );
    expect(provider?.model).toBe('openai/gpt-oss-120b');
  });
});
