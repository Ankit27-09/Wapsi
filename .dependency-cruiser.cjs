/**
 * The Chinese wall, as a build failure.
 *
 * The single most important structural fact in this repository: the policy engine's
 * published success priors and the simulator's ground-truth priors are separately
 * sourced and may never see each other. If they could, the measured recovery
 * advantage would be an identity rather than an inference — the policy would be a
 * mirror of the oracle it is graded against, and the headline number would carry no
 * information at all.
 *
 * Two things this file learned the hard way, both by deliberately injecting a breach:
 *
 *   1. `exclude` DELETES modules from the graph, while `doNotFollow` keeps the edge and
 *      skips the internals. Excluding node_modules meant workspace imports — which
 *      resolve through a symlink — vanished before any rule could see them, and the wall
 *      rules passed with a forbidden import sitting in the file.
 *
 *   2. Matching a single EDGE is not enough. The simulator once imported @rc/engine for
 *      the Gateway interface, and the engine imports @rc/policy: a two-hop route from
 *      simulator to policy that every direct-edge rule waved through. The rules below use
 *      `reachable`, so they match any PATH, and the port was moved to @rc/core.
 *
 * `pnpm lint:boundaries` runs in CI and pre-commit. This is not a convention someone
 * maintains; it is a check that fails the build.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */

// Both shapes a cross-package import can take: a relative path into the sibling package,
// and the workspace specifier, which pnpm resolves through a node_modules symlink.
const POLICY = '(^packages/policy|node_modules[\\\\/]@rc[\\\\/]policy)';
const SIMULATOR = '(^packages/simulator|node_modules[\\\\/]@rc[\\\\/]simulator)';

module.exports = {
  forbidden: [
    {
      name: 'chinese-wall-policy-to-sim',
      severity: 'error',
      comment:
        'The policy engine must never reach simulator ground truth, directly or through ' +
        'any number of intermediate packages. It is required to be capable of being WRONG ' +
        'about the world — that is the only condition under which the measured result ' +
        'carries information. See docs/IMPLEMENTATION-PLAN.md §2.',
      from: { path: '^packages/policy' },
      to: { path: SIMULATOR, reachable: true },
    },
    {
      name: 'chinese-wall-sim-to-policy',
      severity: 'error',
      comment:
        'The simulator must not be tuned against the policy it is used to evaluate, ' +
        'directly or transitively.',
      from: { path: '^packages/simulator' },
      to: { path: POLICY, reachable: true },
    },
    {
      name: 'chinese-wall-detect-to-sim',
      severity: 'error',
      comment:
        'The detector must never reach the simulator, because the simulator holds the ' +
        'ANSWER KEY: `outages` in priors.truth.yaml names exactly which cohort degraded, ' +
        'when, and why. A detector that could read that would score perfectly and would ' +
        'have measured nothing — precision, recall and detection delay are only ' +
        'measurements because the thing being measured cannot see them. ' +
        'The scoring function takes the episodes as an ARGUMENT, supplied by the ' +
        'evaluation harness, which is allowed to read truth because grading is its job.',
      from: { path: '^packages/detect' },
      to: { path: SIMULATOR, reachable: true },
    },
    {
      name: 'core-stays-pure',
      severity: 'error',
      comment:
        '@rc/core is shared vocabulary — money, ids, taxonomy, time, and the Gateway port. ' +
        'It must have no dependencies of its own so every other package, on either side of ' +
        'the wall, can depend on it freely. That is what makes it the only safe home for a ' +
        'contract both halves must see.',
      from: { path: '^packages/core' },
      to: { path: '^(packages/(?!core)|apps/)' },
    },
    {
      name: 'no-simulator-in-production-paths',
      severity: 'error',
      comment:
        'The simulator is evaluation scaffolding. It must not leak into the UI, or the ' +
        'system stops being a prototype of something real.',
      from: { path: '^apps/web' },
      to: { path: SIMULATOR, reachable: true },
    },
    {
      name: 'razorpay-client-decides-nothing',
      severity: 'error',
      comment:
        'The live Razorpay client executes decisions; it must never make one. Reaching ' +
        '@rc/policy from here would let a gateway adapter read a prior, price an action, or ' +
        'consult a bound — and the moment the thing talking to a real payment processor can ' +
        'decide anything, "the engine decided and the client carried it out" stops being ' +
        'true. It is also the shape of the mistake that would put decision logic in two ' +
        'places, one of which is only exercised when the wifi works.',
      from: { path: '^packages/razorpay' },
      to: { path: POLICY, reachable: true },
    },
    {
      name: 'no-razorpay-in-the-measurement',
      severity: 'error',
      comment:
        'The evaluation must not reach the live gateway, directly or transitively. Every ' +
        'measured claim in this project — above all a share of an achievable ceiling — ' +
        'requires ground truth, which exists only in a world somebody wrote down. A network ' +
        'call inside the eval path would make the headline number depend on a third party ' +
        'being reachable, non-reproducible across runs, and no longer a measurement at all.',
      from: { path: '^packages/(eval|simulator|policy|engine)' },
      to: { path: '(^packages/razorpay|node_modules[\\\\/]@rc[\\\\/]razorpay)', reachable: true },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'An import that does not resolve is either a typo or a workspace dependency ' +
        'nobody declared. It fails at runtime, so it should fail at lint time. This also ' +
        'closes the wall from the other side: a forbidden cross-package import that was ' +
        'never added to the manifest is unresolvable rather than merely mis-pathed, and ' +
        'would otherwise slip past the path rules above.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the boundary rules above unenforceable.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Dead modules are redundant code. Delete them.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          // Framework config files are loaded by convention rather than imported, so being
          // unreferenced is correct for them and says nothing about dead code.
          '(^|/)next\\.config\\.mjs$',
          '(^|/)next-env\\.d\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    // Third-party modules stay in the graph as leaves: the edge is visible, the internals
    // are not traversed. Workspace packages never reach here — see `tsConfig` below, which
    // maps every `@rc/*` specifier to its source directory, so a cross-package import is an
    // ordinary source-to-source edge rather than a trip through node_modules.
    doNotFollow: { path: 'node_modules' },

    /*
     * Build output and coverage. The shape of this pattern is load-bearing, and getting it
     * wrong silently disabled every wall rule in this file for the life of the project.
     *
     * WHAT WENT WRONG. pnpm resolves a workspace import through
     * `packages/policy/node_modules/@rc/core`, dependency-cruiser follows that symlink to its
     * real target, and the edge lands on `packages/core/dist/index.js`. `dist` was excluded —
     * and `exclude` DELETES a module from the graph rather than keeping it as a leaf, which
     * is the distinction the header note above was already warning about. So every workspace
     * edge vanished before any rule could see it.
     *
     * Verified by injecting the breach rather than by reading the config: with
     * `import { loadTruthModel } from '@rc/simulator'` in `packages/policy/src/ev.ts` and the
     * dependency properly declared, dependency-cruiser reported that file as having ZERO
     * dependencies and `pnpm lint:boundaries` passed clean. Only the ESLint layer objected.
     * The "two independent checks" this project claims were one check and a decoration.
     *
     * Anchoring the pattern to `packages/*\/dist` did not help — symlinks are resolved, so
     * that is exactly where the edges land. Dropping the exclusion entirely did not help
     * either: compiled output in the graph makes the parser fail outright ("Unexpected
     * template string") and then NO rule runs.
     *
     * The fix is upstream of this line, in `tsConfig`: resolve `@rc/*` to source, so the
     * graph never touches `dist` and excluding it costs nothing.
     */
    exclude: { path: '(^|[\\\\/])(dist|\\.next|coverage)([\\\\/]|$)' },

    tsPreCompilationDeps: true,
    /*
     * A dedicated tsconfig whose only job is `paths: { "@rc/*": ["packages/*\/src/index.ts"] }`.
     *
     * That mapping is what makes the boundary rules operate on real edges: a cross-package
     * import resolves to the sibling package's SOURCE, so the graph is source-to-source,
     * `dist` stays out of it, and `reachable: true` has a connected graph to search.
     *
     * Deliberately not merged into `tsconfig.base.json`. Adding `paths` there would let a
     * developer import across packages without declaring the dependency and have the build
     * accept it — trading one silently-disabled guarantee for another.
     */
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
