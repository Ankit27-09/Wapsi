import tseslint from 'typescript-eslint';

/**
 * Lint rules that exist to protect specific invariants, not to enforce taste.
 *
 * Formatting is not linted — that is noise in review. Everything below either prevents
 * a class of bug this system cannot afford, or enforces a boundary the architecture
 * depends on.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      'artifacts/**',
      '*.cjs',
      'eslint.config.js',
      'vitest.config.ts',
    ],
  },

  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // A dedicated lint config rather than `projectService: true`. The build configs
        // exclude test files so they stay out of dist/, which means the project service
        // cannot find them; tsconfig.lint.json includes everything and emits nothing, so
        // tests get the same type-aware linting as the code they test.
        project: ['./tsconfig.lint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // ---- the money path -------------------------------------------------
      // `any` is how a float gets into an amount: one `as any` and the branded Paise
      // type stops protecting anything downstream of it.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // A dropped promise in the worker is a decision that was written but never
      // dispatched, or an audit row that never landed. Both are silent.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Money is integer paise and rates are integer basis points. If you need to ' +
            'parse an amount, use paiseFromString or paiseFromRupeeString from @rc/core.',
        },
      ],

      'no-restricted-syntax': [
        'error',
        {
          // Kysely parameterises everything through its query builder. `sql.raw` takes a
          // string and interpolates it, which is the one door through which SQL injection
          // could enter. It is legitimate in the migrator, which executes trusted files
          // from disk, and nowhere else.
          selector:
            'MemberExpression[object.name="sql"][property.name="raw"]',
          message:
            'sql.raw bypasses parameterisation. Use the query builder, or the sql`` tagged ' +
            'template which parameterises its interpolations. Permitted only in migrate.ts.',
        },
        {
          // `Number(someAmount)` is the other way a float enters. There is no legitimate
          // reason to coerce a bigint to a number in this codebase.
          selector: 'CallExpression[callee.name="Number"] > Identifier[name=/[Pp]aise$/]',
          message: 'Do not coerce paise to a JS number. Use toRupeeString or formatINR.',
        },
      ],

      // ---- clarity ---------------------------------------------------------
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // ---- the Chinese wall, enforced on the import specifier ------------------
  //
  // dependency-cruiser enforces this too, but it works on *resolved* module paths, and a
  // pnpm workspace import resolves through a node_modules symlink — which is how that
  // rule silently passed with a forbidden import sitting in the file. This layer matches
  // the specifier as written, so no resolution is involved and nothing can be excluded
  // out of the graph before the check runs.
  //
  // Type-only imports are banned as well. A type cannot leak a probability, so this is
  // stricter than strictly necessary — but the wall is the submission's most important
  // structural claim, and "no edge at all" is a far easier thing to defend than "an edge
  // that we argue is harmless". The timing vocabulary is deliberately duplicated in
  // `simulator/src/truth.ts` for exactly this reason, with a test asserting the two stay
  // in step.
  {
    files: ['packages/policy/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@rc/simulator', '@rc/simulator/*', '**/simulator/**'],
              allowTypeImports: false,
              message:
                'CHINESE WALL: the policy engine must never read simulator ground truth. ' +
                'It is required to be capable of being WRONG about the world — that is the ' +
                'only condition under which the measured recovery result carries ' +
                'information. See docs/IMPLEMENTATION-PLAN.md §2.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/simulator/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@rc/policy', '@rc/policy/*', '**/policy/**'],
              allowTypeImports: false,
              message:
                'CHINESE WALL: the simulator must not be tuned against the policy it is ' +
                'used to evaluate.',
            },
          ],
        },
      ],
    },
  },

  {
    // The migrator's whole job is to execute trusted SQL files from disk. The rule above
    // is scoped off here rather than suppressed inline, so the exemption is visible in
    // one place instead of buried at a call site.
    files: ['packages/db/src/migrate.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    // Tests assert on shapes and deliberately construct invalid input. The unsafe-* rules
    // fire constantly on `expect(...)` chains and add nothing.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',

      // A test double implementing an async port synchronously is correct, not lazy: the
      // `Gateway` interface returns promises, and a scripted stand-in has nothing to wait
      // for. Forcing a pointless `await` in to satisfy the rule would be worse.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // Build scripts are plain ESM, deliberately outside the TypeScript project so they run
    // without a build step. Type-aware rules cannot apply to a file the compiler does not
    // see, so they are switched off here rather than the file being left unlinted.
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
);
