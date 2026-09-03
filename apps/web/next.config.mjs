import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * THE CONSOLE READS THE REPOSITORY'S `.env`, NOT ONE OF ITS OWN.
 *
 * Next auto-loads `.env` from its own project root — `apps/web` — and nowhere else. Every
 * other entry point in this repository is a Node command run from the workspace root with
 * `--env-file-if-exists=.env`, so the keys live in one file at the top. Without this, the two
 * halves of the product disagree about what is configured: `pnpm razorpay --live` issues a
 * link with the key in `.env`, and the console next to it reports that no key is set.
 *
 * That divergence is not hypothetical — it is exactly how this was found. The dispatch button
 * said `RESEND_API_KEY is not set` while the key sat in `.env`, and the same silence would
 * have blocked the Razorpay lookup, so every dispatched mail would have carried no link with
 * a warning that read like a Razorpay outage.
 *
 * WHY NOT A SECOND `.env` IN `apps/web`: two files holding the same secrets drift, and the
 * one you are not looking at is always the stale one. WHY NOT A SYMLINK: they need developer
 * mode or elevation on Windows, which is where this runs.
 *
 * `loadEnvFile` does not overwrite a variable already present in the real environment, so a
 * shell export or a CI secret still wins over the file — the precedence every other entry
 * point in this repository already has. Missing file is not an error: a deployment supplies
 * its environment directly and has no `.env` at all.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  process.loadEnvFile(join(root, '.env'));
} catch {
  // No `.env` present. Correct in CI and in any real deployment.
}

/** @type {import('next').NextConfig} */
export default {
  // The workspace packages ship compiled ESM from `dist/`, which Next can consume directly.
  // Listed explicitly so a change to one of them invalidates the build rather than serving
  // a stale copy.
  transpilePackages: ['@rc/core', '@rc/db'],

  // Every page reads live data from Postgres, so nothing here is prerenderable at build
  // time. Saying so explicitly avoids Next attempting static generation and failing at
  // build with a database connection error.
  experimental: {
    serverComponentsExternalPackages: ['pg', 'kysely'],
  },

  eslint: { ignoreDuringBuilds: true },
};
