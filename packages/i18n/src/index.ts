import { en, type Catalog } from "./catalog/en";

type Join<K extends string, Prefix extends string> =
  Prefix extends "" ? K : `${Prefix}.${K}`;

/** All dot-paths of a nested string catalog, as literal types. */
type DotPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? Join<K, Prefix>
    : DotPaths<T[K], Join<K, Prefix>>;
}[keyof T & string];

/**
 * Dot-separated, type-safe message keys derived from the English catalog, e.g.
 * `common.health.ok` or `errors.validation.title`.
 */
export type MessageKey = DotPaths<Catalog>;

/** Look up a message by a typed key, with `{placeholder}` interpolation. */
export function t(
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const value = resolve(en, key.split("."));
  if (value === undefined) {
    // Catalog drift is a programming error, not a runtime fallback situation.
    throw new Error(`Missing i18n message: ${key}`);
  }
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params ?? {}, name)
      ? String(params[name])
      : match,
  );
}

function resolve(node: unknown, segments: string[]): string | undefined {
  let current: unknown = node;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : undefined;
}

/** The message catalog itself (for tests, tooling and future locales). */
export { en };
