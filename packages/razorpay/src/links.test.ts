import { afterEach, describe, expect, it, vi } from 'vitest';
import { paise, paiseFromRupeeString } from '@rc/core';
import { RazorpayError } from './client.js';
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
  customerEmail: 'test@recovery-controller.invalid',
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

  it('surfaces the contradiction when a duplicate cannot then be found', async () => {
    // Razorpay saying the reference exists and then not returning it. Retrying the create
    // would loop; inventing a link would report a demand that was never made.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          ok({ error: { description: 'Reference id already exists' } }, 400),
        )
        .mockResolvedValueOnce(ok({ payment_links: [] })),
    );

    await expect(ensureLink(config, request)).rejects.toBeInstanceOf(RazorpayError);
  });

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
