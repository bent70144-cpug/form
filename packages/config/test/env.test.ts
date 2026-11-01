import { describe, expect, it } from "vitest";
import {
  EnvValidationError,
  bootstrapEnvSchema,
  loadEnv,
  migratorEnvSchema,
  webEnvSchema,
  workerEnvSchema,
} from "../src/env";

const VALID_WORKER_ENV = {
  NODE_ENV: "test",
  WORKER_DATABASE_URL: "postgres://worker_user:pw@localhost:5433/form_test",
  LOG_LEVEL: "info",
};

describe("loadEnv", () => {
  it("accepts a valid worker environment", () => {
    const env = loadEnv(workerEnvSchema, VALID_WORKER_ENV);
    expect(env.WORKER_DATABASE_URL).toContain("worker_user");
    expect(env.HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it("fails with every missing variable listed", () => {
    expect(() => loadEnv(workerEnvSchema, {})).toThrow(EnvValidationError);
    try {
      loadEnv(workerEnvSchema, {});
      expect.unreachable();
    } catch (err) {
      const issues = (err as EnvValidationError).issues.map((i) =>
        i.path.join("."),
      );
      expect(issues).toContain("WORKER_DATABASE_URL");
    }
  });

  it("rejects non-postgres connection strings", () => {
    expect(() =>
      loadEnv(workerEnvSchema, {
        ...VALID_WORKER_ENV,
        WORKER_DATABASE_URL: "mysql://x",
      }),
    ).toThrow(/postgres/);
  });

  it("rejects a non-numeric or non-positive HEARTBEAT_INTERVAL_MS", () => {
    expect(() =>
      loadEnv(workerEnvSchema, {
        ...VALID_WORKER_ENV,
        HEARTBEAT_INTERVAL_MS: "soon",
      }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv(workerEnvSchema, {
        ...VALID_WORKER_ENV,
        HEARTBEAT_INTERVAL_MS: "0",
      }),
    ).toThrow(EnvValidationError);
  });

  it("defaults the heartbeat/dispatch cadence to 30s (ADR-0003)", () => {
    const env = loadEnv(workerEnvSchema, {
      WORKER_DATABASE_URL: "postgres://worker_user:pw@localhost:5433/form_test",
    });
    expect(env.HEARTBEAT_INTERVAL_MS).toBe(30_000);
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
