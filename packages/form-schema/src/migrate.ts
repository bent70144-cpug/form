/**
 * schemaVersion migrations (spec: "Published schemas are immutable;
 * `schemaVersion` migrations are explicit registered functions, never in-place
 * JSON edits"). Version 1 is the identity. Future versions register a function
 * from the previous shape to the next — never mutate envelopes in place.
 */
import type { FormSchema } from "./types";

export type MigrationFn = (envelope: FormSchema) => FormSchema;

/**
 * Registry keyed by the schemaVersion a function migrates FROM. Exposed for
 * tests and tooling; production code registers through `registerMigration`.
 */
export const migrationRegistry = new Map<number, MigrationFn>();

// v1 is the current version: identity, by definition.
migrationRegistry.set(1, (envelope) => envelope);

/** Register a migration for `fromVersion`. Duplicate registration throws. */
export function registerMigration(fromVersion: number, migrate: MigrationFn): void {
  if (migrationRegistry.has(fromVersion)) {
    throw new Error(`migration for schemaVersion ${fromVersion} already registered`);
  }
  migrationRegistry.set(fromVersion, migrate);
}

/** Thrown for envelopes whose schemaVersion has no registered migration. */
export class SchemaMigrationError extends Error {
  readonly code = "unsupported_schema_version" as const;
  readonly schemaVersion: unknown;

  constructor(schemaVersion: unknown) {
    super(`unsupported_schema_version: ${String(schemaVersion)}`);
    this.name = "SchemaMigrationError";
    this.schemaVersion = schemaVersion;
  }
}

/**
 * Migrate an envelope to the current schema version by walking the registry.
 * Throws `SchemaMigrationError` (code `unsupported_schema_version`) for
 * missing, non-integer or unregistered versions.
 */
export function migrateSchema(envelope: unknown): FormSchema {
  const version =
    typeof envelope === "object" && envelope !== null
      ? (envelope as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    !migrationRegistry.has(version)
  ) {
    throw new SchemaMigrationError(version);
  }
  const migrate = migrationRegistry.get(version);
  if (migrate === undefined) throw new SchemaMigrationError(version);
  return migrate(envelope as FormSchema);
}
