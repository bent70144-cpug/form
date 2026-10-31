import { describe, expect, it } from "vitest";
import {
  EnvValidationError,
  apiEnvSchema,
  bootstrapEnvSchema,
  loadEnv,
  migratorEnvSchema,
  webEnvSchema,
  workerEnvSchema,
} from "../src/env";

const VALID_API_ENV = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: "postgres://app_user:pw@localhost:5433/form_test",
  APP_ORIGIN: "http://localhost:3000",
  LOG_LEVEL: "info",
};

describe("loadEnv", () => {
  it("accepts a valid API environment", () => {
    const env = loadEnv(apiEnvSchema, VALID_API_ENV);
    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_URL).toContain("app_user");
  });

  it("fails with every missing variable listed", () => {
    expect(() => loadEnv(apiEnvSchema, {})).toThrow(EnvValidationError);
    try {
      loadEnv(apiEnvSchema, {});
      expect.unreachable();
    } catch (err) {
      const issues = (err as EnvValidationError).issues.map((i) =>
        i.path.join("."),
      );
      expect(issues).toContain("DATABASE_URL");
      expect(issues).toContain("APP_ORIGIN");
    }
  });

  it("rejects non-postgres connection strings", () => {
    expect(() =>
      loadEnv(apiEnvSchema, { ...VALID_API_ENV, DATABASE_URL: "mysql://x" }),
    ).toThrow(/postgres/);
  });

  it("rejects non-numeric PORT", () => {
    expect(() =>
      loadEnv(apiEnvSchema, { ...VALID_API_ENV, PORT: "not-a-number" }),
    ).toThrow(EnvValidationError);
  });

  it("validates the worker environment", () => {
    const env = loadEnv(workerEnvSchema, {
      WORKER_DATABASE_URL: "postgres://worker_user:pw@localhost:5433/form_test",
    });
    expect(env.HEARTBEAT_INTERVAL_MS).toBe(10_000);
  });

  it("validates the migrator environment", () => {
    const env = loadEnv(migratorEnvSchema, {
      MIGRATOR_DATABASE_URL: "postgres://migrator:pw@localhost:5433/form_test",
    });
    expect(env.MIGRATOR_DATABASE_URL).toContain("migrator");
  });

  it("requires role passwords for the bootstrap environment", () => {
    expect(() =>
      loadEnv(bootstrapEnvSchema, { ADMIN_DATABASE_URL: "postgres://u@h/db" }),
    ).toThrow(EnvValidationError);

    const env = loadEnv(bootstrapEnvSchema, {
      ADMIN_DATABASE_URL: "postgres://u@h/db",
      MIGRATOR_PASSWORD: "migrator-password",
      APP_USER_PASSWORD: "app-user-password",
      WORKER_PASSWORD: "worker-password",
    });
    expect(env.APP_USER_PASSWORD).toBe("app-user-password");
  });

  it("validates the web environment (public variables only)", () => {
    const env = loadEnv(webEnvSchema, {
      PORT: "3000",
      APP_ORIGIN: "http://localhost:3000",
      API_INTERNAL_URL: "http://127.0.0.1:4000",
    });
    expect(env.PORT).toBe(3000);
    expect(env.API_INTERNAL_URL).toBe("http://127.0.0.1:4000");
  });

  it("rejects a web environment with a non-URL internal API value", () => {
    expect(() =>
      loadEnv(webEnvSchema, {
        APP_ORIGIN: "http://localhost:3000",
        API_INTERNAL_URL: "not-a-url",
      }),
    ).toThrow(EnvValidationError);
  });
});
