import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Integration tests need DATABASE_URL. Node's `--env-file` is not available inside the
// vitest worker, so .env is loaded here instead — with an empty prefix, because the
// default only exposes VITE_* and none of these are client variables.
const env = loadEnv('test', process.cwd(), '');

export default defineConfig({
  // Match the tsconfig target. Without this, the transform pipeline targets an older
  // baseline than the type checker assumes, and BigInt-heavy code fails to build for
  // reasons that look like syntax errors.
  esbuild: { target: 'es2023' },

  test: {
    env,

    // Property tests and Testcontainers-backed integration tests live side by side.
    // Separate them by name so `vitest run unit` stays fast enough to run on save while
    // the container-backed suite runs on demand and in CI.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],

    // fast-check shrinking and container startup both exceed the 5s default.
    testTimeout: 30_000,
    hookTimeout: 60_000,

    // Integration tests share one Postgres instance and claim rows with
    // FOR UPDATE SKIP LOCKED. Running files in parallel against the same database is
    // exactly what those tests are checking is safe — but it makes failures ambiguous,
    // so files are serialised and concurrency is expressed inside a test instead.
    fileParallelism: false,

    reporters: process.env['CI'] === 'true' ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'artifacts/junit.xml' },
  },
});
