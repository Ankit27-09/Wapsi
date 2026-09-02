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

    yaml = setInReasonBlock(yaml, code, 'min_gap_hours', change.to_value);
  }

  return yaml.replace(/^version: \d+/m, `version: ${policy.version + 1}`);
}

/** Indentation of a top-level entry under `reason_codes:`. */
const BASE_ENTRY_INDENT = 2;

/**
 * Replace a scalar inside one reason code's BASE block.
 *
 * WHY THIS IS LINE-BASED AND NOT A REGEX, having previously been a regex.
 *
 * The old pattern was `(  <code>:[\s\S]*?min_gap_hours: )(\d+)` — scoped to the code's block
 * by relying on the lazy quantifier stopping at the first match after the code's key. That
 * held only while each code appeared exactly once in the file, and it stopped holding the
 * moment per-risk-class overrides arrived: a code can now appear both under `reason_codes:`
 * and again, more deeply indented, under `class_overrides:`.
 *
 * The consequence was silent and precisely the failure this module exists to prevent. Asking
 * to change `card_expired.min_gap_hours` — a base entry with no such line — let the lazy
 * match run past the end of the block and rewrite the SUBSCRIPTION override's value instead.
 * No error, wrong file edited, and a held-out comparison that would have reported the effect
 * of a change nobody proposed.
 *
 * So the block is located structurally: the line `  <code>:` at exactly two spaces of
 * indentation, ending at the next line indented no further. A match outside those bounds is
 * not a near miss to be tolerated, it is a different setting.
 *
 * Class overrides are deliberately NOT reachable from here. The proposal schema carries a
 * reason code and no risk class, so there is no way for a proposal to express which of
 * several blocks it means — and inferring one would be guessing at which customers a change
 * applies to.
 */
function setInReasonBlock(
  yaml: string,
  code: string,
  field: string,
  value: number,
): string {
  const lines = yaml.split('\n');
  const keyLine = `${' '.repeat(BASE_ENTRY_INDENT)}${code}:`;

  const start = lines.findIndex((line) => line === keyLine);
  if (start === -1) {
    throw new Error(
      `Failed to apply ${code}.${field}: no base entry "${keyLine.trim()}" at ` +
        `${BASE_ENTRY_INDENT}-space indentation. A code that exists only as a class ` +
        `override cannot be changed by a proposal, which carries no risk class.`,
    );
  }

  // The block runs until the next non-blank line indented no deeper than the key itself.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= BASE_ENTRY_INDENT) {
      end = i;
      break;
    }
  }

  const pattern = new RegExp(`^(\\s*${field}: )(-?\\d+)\\s*$`);
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = pattern.exec(line);
    if (match === null) continue;
    lines[i] = `${match[1] ?? ''}${value}`;
    return lines.join('\n');
  }

  // Throwing rather than returning the text unchanged. An unapplied change that flows
  // silently into a held-out comparison produces a confident zero, which is
  // indistinguishable from an honest negative result and far more damaging.
  throw new Error(
    `Failed to apply ${code}.${field}: no matching line found inside the ${code} block ` +
      `(lines ${start + 1}-${end}). The block exists; the field does not.`,
  );
}
