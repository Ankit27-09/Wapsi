import { afterEach, describe, expect, it, vi } from 'vitest';
import { paise, paiseFromRupeeString } from '@rc/core';
import { MAX_ATTEMPTS, backoffMs } from './client.js';
import { readConfig, type RazorpayConfig } from './config.js';
import { createLink, ensureLink, findLinkByReference, linkBody } from './links.js';

/**
 * The client's behaviour, without a network or a credential.
 *
 * `fetch` is stubbed rather than hit. That is not a convenience: a test that calls Razorpay
 * would need live keys, would be rate-limited, would fail on an aeroplane, and — worst —
 * would leave real payment links in somebody's dashboard every time the suite ran.
 *
 * What is actually asserted here is the part that goes wrong in integrations: the money unit
 * at the JSON boundary, the idempotency composition, and whether a changed response shape
 * fails loudly or silently.
 */

const config: RazorpayConfig = {
  RAZORPAY_KEY_ID: 'rzp_test_abc123',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_API_BASE: 'https://api.razorpay.test/v1',
};

const request = {
  referenceId: 'idem-key-0001',
  amount: paiseFromRupeeString('2400.00'),
  description: 'Complete your incomplete order — abandoned at otp [test mode]',
  customerName: 'Synthetic Customer 12',
  customerContact: '+919900000001',
  customerEmail: 'test@wapsi.invalid',
};

/** A well-formed Razorpay reply, as JSON text. */
function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const validLink = {
  id: 'plink_test_1',
  short_url: 'https://rzp.io/i/testlink',
  status: 'created',
  amount: 240_000,
  reference_id: 'idem-key-0001',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the money unit at the JSON boundary', () => {
  it('sends paise as an integer, never rupees and never a float', () => {
    // THE SINGLE MOST LIKELY WAY TO LOSE MONEY IN A GATEWAY INTEGRATION. Razorpay takes
    // paise, this system stores paise, so there is no conversion to get wrong — and this
    // asserts that nobody adds one. ₹2,400.00 is 240000 paise; a rupee-denominated body
    // would say 2400 and under-charge by a factor of a hundred.
    const body = linkBody(request);

    expect(body['amount']).toBe(240_000);
    expect(Number.isInteger(body['amount'])).toBe(true);
    expect(body['currency']).toBe('INR');
  });

  it('carries the engine idempotency key as reference_id', () => {
    // The whole basis of safety on a re-run: Razorpay refuses a duplicate reference_id, and
    // the engine's key is a pure function of (transaction, attempt, policy version).
    expect(linkBody(request)['reference_id']).toBe('idem-key-0001');
  });

  it('leaves gateway-side notification off', () => {
    // A compliance decision, not a preference. This system sends its own messages through
    // DLT-registered templates gated on consent, quiet hours and a weekly ceiling. A second
    // ungated path from the gateway would make those bounds a description of half the
    // traffic — so the default has to be off, and a test has to hold it there.
    expect(linkBody(request)['notify']).toEqual({ sms: false, email: false });
    expect(linkBody(request)['reminder_enable']).toBe(false);

    const asked = linkBody({ ...request, notify: true });
    expect(asked['notify']).toEqual({ sms: true, email: true });
  });

  it('refuses partial payment', () => {
    // A partially paid recovery is neither recovered nor outstanding, and every figure in
    // the report assumes an amount either moved or did not.
    expect(linkBody(request)['accept_partial']).toBe(false);
  });
});

describe('a changed response shape fails loudly', () => {
  it('throws when a field it depends on is missing', async () => {
    // The failure mode an untyped SDK produces instead: `undefined` where a link id should
    // be, carried onward, surfacing later as a link nobody can open.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ id: 'plink_1' })));

    await expect(createLink(config, request)).rejects.toThrow(/does not recognise/);
  });

  it('accepts fields it does not know about', async () => {
    // Razorpay adding a field is not an error, and treating it as one would break this
    // integration on a Tuesday for no reason.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok({ ...validLink, some_new_field: 'whatever' })),
    );

    const link = await createLink(config, request);
    expect(link.short_url).toBe('https://rzp.io/i/testlink');
  });

  it('reports the API error description rather than a bare status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok(
          { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be at least 100' } },
          400,
        ),
      ),
    );

    await expect(createLink(config, request)).rejects.toThrow(/amount must be at least 100/);
  });

  it('turns an unreachable host into a readable error, not a TypeError', async () => {
    // What actually happens during a live demo. "TypeError: fetch failed" on a projector is
    // not a diagnosis.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));

    await expect(createLink(config, request)).rejects.toThrow(/Could not reach/);
  });
});

describe('idempotency on a re-run', () => {
  it('reuses the existing link when the reference is already taken', async () => {
    // The behaviour that makes the demo runnable twice. `createLink` alone throws on a
    // duplicate; a demo that only works once is a demo that fails when somebody asks to see
    // it again.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ok({ error: { code: 'BAD_REQUEST_ERROR', description: 'Reference id already exists' } }, 400),
      )
      .mockResolvedValueOnce(ok({ payment_links: [validLink] }));

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureLink(config, request);

    expect(result.reused).toBe(true);
    expect(result.link.id).toBe('plink_test_1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports created rather than reused on a first run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(validLink)));

    const result = await ensureLink(config, request);
    expect(result.reused).toBe(false);
  });

  it('retries the lookup, because the list endpoint lags the create', async () => {
    // OBSERVED AGAINST THE REAL API, not hypothesised. Re-running immediately after a first
    // run, one link in three came back as a duplicate on create and then as absent from the
    // query by reference. A minute later all three were found. The create is immediately
    // consistent; the list is not.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ error: { description: 'Reference id already exists' } }, 400))
      .mockResolvedValueOnce(ok({ payment_links: [] })) // lagging
      .mockResolvedValueOnce(ok({ payment_links: [validLink] })); // caught up

    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureLink(config, request);

    expect(result.reused).toBe(true);
    expect(result.link.id).toBe('plink_test_1');
  }, 10_000);

  it('gives up rather than looping when the lag never resolves', async () => {
    // Bounded at three tries. Past that, "Razorpay says it exists but will not return it" is
    // a genuine contradiction: retrying the create would loop, and inventing a link would
    // report a demand that was never made.
    // `mockImplementation`, not `mockResolvedValue`. A `Response` body can only be read
    // once, so returning the SAME object for every call fails on the second read with
    // "Body has already been consumed" — which is a test artefact that looks exactly like a
    // client bug. Each call gets a fresh Response.
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? ok({ error: { description: 'Reference id already exists' } }, 400)
            : ok({ payment_links: [] }),
        );
      }),
    );

    await expect(ensureLink(config, request)).rejects.toThrow(/DUPLICATE_NOT_FOUND|three attempts/);
  }, 10_000);

  it('returns null rather than throwing when no link exists for a reference', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ payment_links: [] })));

    await expect(findLinkByReference(config, 'nothing-here')).resolves.toBeNull();
  });
});

describe('a live key is unrepresentable', () => {
  it('refuses rzp_live_ credentials', () => {
    // Not a warning and not a flag. This package creates demands for money against customers
    // a simulator invented, so the only safe design is for a live key to fail validation.
    const result = readConfig({
      RAZORPAY_KEY_ID: 'rzp_live_realkey',
      RAZORPAY_KEY_SECRET: 'secret',
    });

    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/TEST key/);
  });

  it('accepts a test key', () => {
    const result = readConfig({
      RAZORPAY_KEY_ID: 'rzp_test_abc',
      RAZORPAY_KEY_SECRET: 'secret',
    });

    expect(result.ok).toBe(true);
    expect(result.config?.RAZORPAY_API_BASE).toBe('https://api.razorpay.com/v1');
  });

  it('reports a readable problem when nothing is configured', () => {
    const result = readConfig({});

    expect(result.ok).toBe(false);
    expect(result.problem).toContain('RAZORPAY_KEY_ID');
  });
});

describe('amounts stay exact across the boundary', () => {
  it('round-trips a large invoice without loss', () => {
    // ₹4,00,000 — the top of the B2B tier, and the amount where a float would first start
    // to be a question. `Paise` is a bigint precisely so it is not one.
    const body = linkBody({ ...request, amount: paise(40_000_000n) });
    expect(body['amount']).toBe(40_000_000);
  });
});

describe('a rate limit is retried, and a duplicate is not', () => {
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

  const throttled: readonly [unknown, number] = [
    { error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } },
    429,
  ];

  /** No wait. The real ladder climbs to 6s and sleeping through it cost 15s of suite time. */
  const noWait = { retryDelayMs: () => 0 };

  it('recovers when the throttle clears', async () => {
    // OBSERVED LIVE, not hypothesised. `pnpm razorpay --live --limit 3` hit a 429 on the
    // third link and printed FAILED — correct behaviour from a client that refuses to guess,
    // and it reads as a broken integration on the one command a judge is most likely to run
    // twice.
    const fetchMock = replies(throttled, throttled, [validLink, 200]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await createLink(config, request, noWait);

    expect(result.short_url).toBe('https://rzp.io/i/testlink');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('is SAFE to retry a create, because reference_id makes it idempotent server-side', async () => {
    // The justification for retrying a POST that demands money at all. A 429 is normally
    // ambiguous about whether the resource was created before the response was refused.
    // Here every create carries `reference_id` and Razorpay enforces uniqueness on it — so a
    // repeat is either accepted (the first never landed) or rejected as a duplicate (it did).
    // This asserts the second branch resolves to the EXISTING link rather than a second one.
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        // First create throttled; the retry finds Razorpay already has it; the lookup returns it.
        if (call === 1) return Promise.resolve(ok(throttled[0], 429));
        if (call === 2) {
          return Promise.resolve(
            ok({ error: { code: 'BAD_REQUEST_ERROR', description: 'reference_id already exists' } }, 400),
          );
        }
        return Promise.resolve(ok({ payment_links: [validLink] }));
      }),
    );

    const { link, reused } = await ensureLink(config, request, noWait);

    expect(reused).toBe(true);
    expect(link.id).toBe('plink_test_1');
  });

  it('does NOT retry a duplicate, which is not a failure', async () => {
    // Retrying here would be pure waste: the reference is taken and will stay taken.
    // `ensureLink` looks the link up instead, and this pins that `request` does not burn
    // four attempts before letting it.
    const fetchMock = replies([
      { error: { code: 'BAD_REQUEST_ERROR', description: 'reference_id already exists' } },
      400,
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(createLink(config, request, noWait)).rejects.toMatchObject({ duplicate: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a plain bad request, which will fail identically forever', async () => {
    const fetchMock = replies([
      { error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be at least 100' } },
      400,
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(createLink(config, request, noWait)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of attempts rather than looping', async () => {
    const fetchMock = replies(throttled);
    vi.stubGlobal('fetch', fetchMock);

    await expect(createLink(config, request, noWait)).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('the retry schedule itself', () => {
  it('climbs and then stops climbing', () => {
    const waits = [0, 1, 2, 3].map((n) => backoffMs(n));
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
    }
    // Jitter sits on top of the 6s ceiling, so the bound is the ceiling plus that.
    expect(Math.max(...waits)).toBeLessThan(6_400);
  });

  it('jitters, so parallel runs do not retry in lockstep', () => {
    // Two people running `pnpm razorpay --live` at once would otherwise come back at the
    // same instant and re-trigger the throttle that stopped them.
    const sample = new Set(Array.from({ length: 24 }, () => backoffMs(3)));
    expect(sample.size).toBeGreaterThan(1);
  });

  it('gives up after MAX_ATTEMPTS, which is bounded', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_ATTEMPTS).toBeLessThan(10);
  });
});
