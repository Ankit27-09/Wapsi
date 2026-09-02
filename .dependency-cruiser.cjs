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
    // Keeps third-party modules in the graph as leaves: the edge is visible, the internals
    // are not traversed.
    doNotFollow: { path: 'node_modules' },

    // Only build output and coverage. See note 1 in the header — excluding node_modules
    // here is what silently disabled the wall.
    exclude: { path: '(dist|\\.next|coverage)' },

    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
