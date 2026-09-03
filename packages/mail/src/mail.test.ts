import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paiseFromRupeeString } from '@rc/core';
import {
  MailError,
  createResend,
  htmlFor,
  resolveMail,
  subjectFor,
  textFor,
  type DispatchInput,
} from './index.js';

/**
 * The dispatch path, without a network and without a key.
 *
 * What is asserted is the part that would actually go wrong: whether the recipient can ever
 * be a customer, whether the arithmetic survives into the body, and whether the free tier's
 * one predictable failure arrives as something an operator can act on.
 */

const input: DispatchInput = {
  message: 'Hi Asha, your payment of Rs 55,560.83 to Devkit Supplies did not complete.',
  templateId: 'tpl_ca_addr_hi_v2',
  dltTemplateId: 'DLT1207160000000009',
  amount: paiseFromRupeeString('55560.83'),
  reasonCode: 'abandoned_at_address',
  riskClass: 'checkout_abandonment',
  attemptNo: 1,
  paymentUrl: 'https://rzp.io/rzp/K6oKFrR',
  decisionId: '7f3a91c2-0000-4000-8000-000000000001',
  pBps: 3400,
  value: paiseFromRupeeString('1055.65'),
  cost: paiseFromRupeeString('0.18'),
  net: paiseFromRupeeString('358.74'),
  floor: paiseFromRupeeString('5.00'),
  refusedInBatch: 248,
  decisionsInBatch: 544,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the recipient can never be a customer', () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

  it('refuses to resolve without MAIL_TO, rather than defaulting one', () => {
    // THE WHOLE SAFETY ARGUMENT OF THIS PACKAGE. The engine has no email channel — zero
    // registered email templates, no email consent in the seeded book — so any default
    // recipient would turn a preview into an outreach channel the compliance layer refuses.
    // Failing closed is the only correct behaviour.
    const { provider, problem } = resolveMail(env({ RESEND_API_KEY: 'k' }));
    expect(provider).toBeNull();
    expect(problem).toMatch(/MAIL_TO/);
  });

  it('says where to get a key when none is set', () => {
    const { provider, problem } = resolveMail(env({ MAIL_TO: 'me@example.com' }));
    expect(provider).toBeNull();
    expect(problem).toMatch(/resend\.com/);
  });

  it('treats a placeholder key as absent', () => {
    // `.env.example` ships `RESEND_API_KEY=...`, and a copied file failing on authentication
    // is worse than one reporting that nothing is configured.
    expect(resolveMail(env({ RESEND_API_KEY: '...', MAIL_TO: 'a@b.com' })).provider).toBeNull();
  });

  it('refuses a MAIL_TO that is not an address', () => {
    const { problem } = resolveMail(env({ RESEND_API_KEY: 'k', MAIL_TO: 'not-an-address' }));
    expect(problem).toMatch(/not an address/);
  });

  it('resolves when both are present', () => {
    const { provider, to, problem } = resolveMail(
      env({ RESEND_API_KEY: 'k', MAIL_TO: 'me@example.com' }),
    );
    expect(problem).toBeNull();
    expect(provider?.id).toBe('resend');
    expect(to).toBe('me@example.com');
  });
});

describe('the arithmetic reaches the body', () => {
  it('carries every term of the gate, not just the outcome', () => {
    // The differentiator, and it is worth a test: any recovery email says "your payment
    // failed, here is a link". This one has to say WHY it exists, in the same numbers the
    // decision was made on. A body that lost them would be the one place the system's
    // central claim stopped being true.
    const html = htmlFor(input);
    expect(html).toContain('34.00%');            // probability
    expect(html).toContain('₹1,055.65');          // value at stake
    expect(html).toContain('₹0.18');              // cost to send
    expect(html).toContain('₹358.74');            // expected net
    expect(html).toContain('₹5.00');              // the floor it cleared
    expect(html).toContain('248 of 544');         // the restraint around it
  });

  it('names the registered template and its DLT id', () => {
    const html = htmlFor(input);
    expect(html).toContain('tpl_ca_addr_hi_v2');
    expect(html).toContain('DLT1207160000000009');
  });

  it('states that the population is simulated, in the body', () => {
    // Not a footnote in a README a judge may not open. If this email is forwarded, the
    // disclosure has to travel with it.
    expect(htmlFor(input)).toMatch(/[Ss]imulated/);
    expect(textFor(input)).toMatch(/No real customer was contacted/);
  });

  it('always ships a plain-text alternative', () => {
    // A multipart message without one scores worse in every spam filter, and a client that
    // blocks HTML would otherwise show an empty email at the moment it matters most.
    const text = textFor(input);
    expect(text).toContain('https://rzp.io/rzp/K6oKFrR');
    expect(text).toContain('expected net');
    expect(text.length).toBeGreaterThan(200);
  });

  it('says so plainly when no link has been issued', () => {
    const html = htmlFor({ ...input, paymentUrl: null });
    expect(html).toMatch(/No payment link has been issued/);
    expect(html).not.toContain('Complete your payment');
  });

  it('escapes template text, so a cause cannot break the markup', () => {
    const html = htmlFor({ ...input, message: 'pay <script>alert(1)</script> now' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('puts the amount in the subject, where a mail client shows it', () => {
    expect(subjectFor(input)).toBe('Payment of ₹55,560.83 could not be completed');
  });
});

describe('the free tier has one predictable failure', () => {
  const provider = createResend({ apiKey: 'k', baseUrl: 'https://resend.test' });
  const message = { to: 'a@b.com', from: 'x@y.com', subject: 's', html: '<p>h</p>', text: 't' };

  it('rewrites a 403 into the actual cause', () => {
    // Resend's own wording for "you have no verified domain so you may only mail yourself"
    // reads like a rejected key. An operator who follows that reading goes and regenerates a
    // perfectly good credential.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: 'You can only send testing emails' }), {
            status: 403,
          }),
        ),
      ),
    );

    return provider.send(message).catch((cause: unknown) => {
      expect(cause).toBeInstanceOf(MailError);
      expect((cause as MailError).message).toMatch(/only delivers to the address/);
      expect((cause as MailError).message).toMatch(/MAIL_TO/);
    });
  });

  it('returns the queued id on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ id: 'abc-123' })))),
    );

    const result = await provider.send(message);
    expect(result).toEqual({ id: 'abc-123', provider: 'resend' });
  });

  it('reports an unrecognised 200 body rather than claiming success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ queued: true })))),
    );

    await expect(provider.send(message)).rejects.toThrow(/does not recognise/);
  });

  it('maps an unreachable host to a network failure, not a TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ENOTFOUND'))));
    await expect(provider.send(message)).rejects.toMatchObject({ status: 0 });
  });
});

describe('the console cannot create a payment link', () => {
  it('dispatch.ts looks a link up and never issues one', () => {
    // A DOCUMENTATION LOCK on a boundary no type can express.
    //
    // `ensureLink` and `createLink` are one import away and would make the demo smoother —
    // click, and a link is minted on the spot. That line is also where a read-only console
    // acquires the ability to demand money from someone. `razorpay-client-decides-nothing`
    // guards this from the package side; nothing guarded it from the console side.
    //
    // If this test fails, someone made the console a payment originator. That may be the
    // right call one day, and it should be a deliberate one.
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'apps/web/app/inbox/dispatch.ts'),
      'utf8',
    );

    // Comments stripped first. The bare-word version of this test failed on the file's own
    // doc comment, which explains why `ensureLink` is NOT used — a lock that fires on prose
    // arguing for the rule it enforces is a lock nobody will keep.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(code).toContain('findLinkByReference(');
    expect(code).not.toMatch(/\bensureLink\s*\(/);
    expect(code).not.toMatch(/\bcreateLink\s*\(/);
    // And it must not have acquired them through the import list either.
    expect(/import\s*\{[^}]*\}\s*from\s*'@rc\/razorpay'/.exec(code)?.[0] ?? '').not.toMatch(
      /ensureLink|createLink/,
    );
  });
});
