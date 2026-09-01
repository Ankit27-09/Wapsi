import type { ProposedChange } from '@rc/ai';
import type { Policy } from '@rc/policy';

/**
 * Apply approved changes to the policy YAML, producing the next version's text.
 *
 * Extracted and unit-tested because a silent failure here would be invisible and
 * catastrophic to the argument: the held-out evaluation would compare a policy against
 * ITSELF, report a delta of exactly zero, and look for all the world like an honest
 * negative result. "The change made no difference" and "the change was never applied" are
 * indistinguishable from the outside, and only one of them is a finding.
 */
export function applyChanges(policy: Policy, changes: readonly ProposedChange[]): string {
  let yaml = policy.yaml;

  for (const change of changes) {
    if (change.field === 'ev_floor_paise') {
      const next = yaml.replace(/ev_floor_paise: \d+/, `ev_floor_paise: ${change.to_value}`);
      if (next === yaml) {
        throw new Error('Failed to apply ev_floor_paise: no matching line in the policy YAML');
      }
      yaml = next;
      continue;
    }

    const code = change.reason_code;
    if (code === null) {
      throw new Error(`${change.field} requires a reason code`);
    }

    // Scoped to the reason code's own block so a value elsewhere in the file cannot be
    // rewritten by accident. The lazy quantifier stops at the FIRST `min_gap_hours` after
    // the code's key, which is that code's own.
    const pattern = new RegExp(`(  ${code}:[\\s\\S]*?min_gap_hours: )(\\d+)`);
    const next = yaml.replace(pattern, `$1${change.to_value}`);

    if (next === yaml) {
      // Throwing rather than returning the text unchanged. An unapplied change that flows
      // silently into a held-out comparison produces a confident zero.
      throw new Error(
        `Failed to apply ${code}.min_gap_hours: no matching line found in the policy YAML`,
      );
    }
    yaml = next;
  }

  return yaml.replace(/^version: \d+/m, `version: ${policy.version + 1}`);
}
