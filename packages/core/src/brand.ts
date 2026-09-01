/**
 * Nominal typing for TypeScript.
 *
 * A `Brand<string, 'TxnId'>` is assignable from nothing but itself, so a customer id
 * cannot be passed where a transaction id is expected, and a raw `bigint` cannot be
 * passed where `Paise` is expected. The brand exists only in the type system — at
 * runtime a branded value is exactly its underlying primitive, so there is no
 * wrapper cost and no serialisation surprise.
 *
 * Declared once here rather than repeated per module, so the pattern stays honest.
 *
 * A named property rather than a `unique symbol`. A symbol is marginally harder to
 * forge, but it cannot be *named* in the declaration files of downstream packages —
 * `tsc` fails with TS4023 the moment another package exports a type that mentions a
 * branded value. The property form has the same practical guarantee here, because the
 * branded types intersect with primitives: there is no way to produce a `bigint` that
 * also carries a property, so `Paise` still cannot be forged.
 */
export type Brand<Underlying, Name extends string> = Underlying & {
  readonly __brand: Name;
};

/**
 * Exhaustiveness guard for discriminated unions.
 *
 * Placed in the `default` branch of a switch, it turns "someone added a variant and
 * forgot to handle it here" from a runtime surprise into a compile error. Used
 * throughout the policy engine, where an unhandled reason code would mean an
 * unhandled way of losing money.
 */
export function assertNever(value: never, context?: string): never {
  throw new Error(
    `Unhandled variant${context === undefined ? '' : ` in ${context}`}: ${JSON.stringify(value)}`,
  );
}
