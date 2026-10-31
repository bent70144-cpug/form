import { describe, expect, it } from "vitest";
import {
  SchemaMigrationError,
  migrateSchema,
  migrationRegistry,
  registerMigration,
} from "../src/index";
import { publishableDraft } from "./factories";

describe("migrateSchema", () => {
  it("returns version-1 envelopes unchanged (identity, same reference)", () => {
    const draft = publishableDraft();
    const migrated = migrateSchema(draft);
    expect(migrated).toBe(draft);
    expect(migrated).toEqual(draft);
  });

  it("handles the empty draft too", () => {
    const draft = {
      schemaVersion: 1,
      title: "",
      blocks: [],
      logic: [],
      theme: { preset: "default" },
      settings: {},
    };
    expect(migrateSchema(draft)).toBe(draft);
  });

  it("throws unsupported_schema_version for unregistered versions", () => {
    for (const badVersion of [2, 0, -1, 999]) {
      let caught: unknown;
      try {
        migrateSchema({ schemaVersion: badVersion });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaMigrationError);
      const err = caught as SchemaMigrationError;
      expect(err.code).toBe("unsupported_schema_version");
      expect(err.message).toContain("unsupported_schema_version");
      expect(err.schemaVersion).toBe(badVersion);
    }
  });

  it("throws unsupported_schema_version for malformed versions", () => {
    for (const bad of [1.5, "1", null, undefined]) {
      expect(() => migrateSchema({ schemaVersion: bad })).toThrowError(
        /unsupported_schema_version/,
      );
    }
    expect(() => migrateSchema({})).toThrowError(/unsupported_schema_version/);
    expect(() => migrateSchema(null)).toThrowError(/unsupported_schema_version/);
    expect(() => migrateSchema("v1")).toThrowError(/unsupported_schema_version/);
  });
});

describe("migration registry", () => {
  const version = 42; // unique per run; cleaned up below

  it("registers explicit functions and never edits JSON in place", () => {
    const from42 = {
      schemaVersion: 42,
      title: "old",
      blocks: [],
      logic: [],
      theme: { preset: "default" } as const,
      settings: {},
    };
    registerMigration(version, (envelope) => ({
      ...(envelope as unknown as typeof from42),
      schemaVersion: 1,
    }));
    const migrated = migrateSchema(from42);
    expect(migrated.schemaVersion).toBe(1);
    expect(from42.schemaVersion).toBe(42); // input untouched
    expect(migrationRegistry.has(version)).toBe(true);
    expect(migrationRegistry.get(1)).not.toBeUndefined();
  });

  it("rejects duplicate registration", () => {
    expect(() => registerMigration(1, (e) => e)).toThrowError(/already registered/);
    expect(() => registerMigration(version, (e) => e)).toThrowError(/already registered/);
  });

  it("clean up test registrations", () => {
    migrationRegistry.delete(version);
    expect(migrationRegistry.has(version)).toBe(false);
    expect(() => migrateSchema({ schemaVersion: version })).toThrowError(
      /unsupported_schema_version/,
    );
  });
});
