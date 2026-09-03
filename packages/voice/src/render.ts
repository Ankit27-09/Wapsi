/**
 * Filling a registered script, and refusing to speak anything else.
 *
 * This is the whole compliance surface of the voice path, and it is one function. A template
 * declares its variables; rendering substitutes exactly those; anything left unsubstituted is
 * an error rather than a placeholder read aloud to a customer.
 */

export interface RenderedScript {
  readonly templateId: string;
  readonly language: string;
  readonly text: string;
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

/**
 * Substitute `{{name}}` placeholders from a declared variable set.
 *
 * FOUR THINGS ARE REFUSED, each a distinct way this goes wrong, and each reported
 * distinguishably — an error that blames the wrong side sends someone editing the wrong file:
 *
 *   - A variable the template did not declare. The caller and the template disagree about
 *     the script, and the quiet outcome is a value silently ignored.
 *   - A declared variable with no value. The alternative is speaking "rupees undefined".
 *   - A VALUE containing `{{`. Values are data. A brace sequence in one is either a bug or an
 *     attempt to smuggle a directive into an approved script, and neither should be spoken.
 *     Refused up front, which is also what keeps the last check unambiguous.
 *   - A leftover `{{...}}` after substitution. With values cleared above, this can only be
 *     the TEMPLATE's own fault: a malformed placeholder like `{{ amount }}` or `{{a-b}}` that
 *     the substitution pattern does not match and no caller data could ever fill.
 *
 * Values are not escaped, because there is no injection target — the output is spoken, not
 * parsed. Substitution is nonetheless single-pass, so even a value that slipped through
 * cannot be re-read as a placeholder on a second sweep.
 */
export function renderScript(
  template: {
    readonly id: string;
    readonly language: string;
    readonly body: string;
    readonly variables: readonly string[];
  },
  values: Readonly<Record<string, string>>,
): RenderedScript {
  const declared = new Set(template.variables);

  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      throw new ScriptError(
        `"${key}" is not declared by ${template.id}. Declared: ${template.variables.join(', ')}`,
      );
    }
  }

  for (const name of template.variables) {
    const value = values[name];
    if (value === undefined) {
      throw new ScriptError(`${template.id} needs "${name}" and none was given`);
    }
    if (value.includes('{{')) {
      throw new ScriptError(
        `The value for "${name}" contains "{{", which a script value may not. Values are ` +
          'data; a brace sequence in one is either a bug or an attempt to introduce a ' +
          'directive into an approved script.',
      );
    }
  }

  // Single pass. A `replace` per variable in a loop would let one value's content be
  // substituted into by the next variable's pattern.
  const text = template.body.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new ScriptError(`${template.id} references "${name}", which it does not declare`);
    }
    return value;
  });

  const leftover = /\{\{[^}]*\}\}/.exec(text);
  if (leftover !== null) {
    // Values were cleared of braces above, so this is the template's own defect: a
    // placeholder the substitution pattern (`{{\w+}}`) does not match — a stray space, a
    // hyphen — which no correct caller data could ever fill.
    throw new ScriptError(
      `${template.id} still contains ${leftover[0]} after rendering. That placeholder is ` +
        'malformed, so no value can fill it — fix the template.',
    );
  }

  return { templateId: template.id, language: template.language, text };
}

/**
 * The provider language tag for a template's language.
 *
 * `hi_latn` maps to `hi-IN` even though the script is Latin characters, and that is the
 * correct call rather than a compromise: the text is Hindi grammar with English nouns, and
 * the target is Hindi phonology. Tagging it `en-IN` makes a synthesiser read "dabaayein" with
 * English vowels, which sounds worse than either language spoken properly.
 */
export function languageTagFor(language: string): string {
  return language === 'hi_latn' ? 'hi-IN' : 'en-IN';
}
