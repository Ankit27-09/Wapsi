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
