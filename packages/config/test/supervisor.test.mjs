import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_WEB_ENV_PATTERN,
  ROLE_ALLOWLISTS,
  buildChildEnv,
  devDefaults,
} from "../../scripts/supervisor.mjs";

const BASE = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/z",
  NODE_ENV: "development",
};

describe("supervisor child environment allowlist", () => {
  it("gives the web process only public variables plus the internal API URL", () => {
    const env = buildChildEnv("web", {
      ...BASE,
      PORT: "3000",
      APP_ORIGIN: "http://localhost:3000",
      API_INTERNAL_URL: "http://127.0.0.1:4000",
      LOG_LEVEL: "info",
      // secrets that exist in the parent environment must NOT leak through
      DATABASE_URL: "postgres://app_user:x@localhost/db",
      MIGRATOR_DATABASE_URL: "postgres://migrator:x@localhost/db",
      WORKER_DATABASE_URL: "postgres://worker:x@localhost/db",
      ADMIN_DATABASE_URL: "postgres://postgres:x@localhost/db",
      BETTER_AUTH_SECRET: "super-secret",
      APP_USER_PASSWORD: "hunter2",
    });
    expect(env["API_INTERNAL_URL"]).toBe("http://127.0.0.1:4000");
    expect(env["APP_ORIGIN"]).toBe("http://localhost:3000");
    expect(env["PATH"]).toBe(BASE.PATH); // system essentials still flow
    // Named forbidden keys (ticket 02): the Next process must never see the
    // database URL, auth secrets, or the migrator URL — checked by key name in
    // addition to the FORBIDDEN_WEB_ENV_PATTERN sweep below.
    for (const forbidden of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "MIGRATOR_DATABASE_URL",
      "ADMIN_DATABASE_URL",
      "WORKER_DATABASE_URL",
      "APP_USER_PASSWORD",
    ]) {
      expect(env[forbidden]).toBeUndefined();
    }
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(FORBIDDEN_WEB_ENV_PATTERN);
    }
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["BETTER_AUTH_SECRET"]).toBeUndefined();
  });

  it("refuses to spawn the web process if a forbidden key would be present", () => {
    // A misconfigured allowlist (forbidden key on web's list) must fail closed
    // rather than leak. Simulate the drift by temporarily adding the key.
    const original = [...ROLE_ALLOWLISTS.web];
    ROLE_ALLOWLISTS.web.push("MIGRATOR_DATABASE_URL");
    try {
      expect(() =>
        buildChildEnv("web", {
          ...BASE,
          MIGRATOR_DATABASE_URL: "postgres://migrator:x@localhost/db",
        }),
      ).toThrow(/forbidden environment keys/i);
    } finally {
      ROLE_ALLOWLISTS.web.length = 0;
      ROLE_ALLOWLISTS.web.push(...original);
    }
  });

  it("gives the API process the pooled app_user URL plus BETTER_AUTH_SECRET but no migrator URL", () => {
    const env = buildChildEnv("api", {
      ...BASE,
      PORT: "4000",
      DATABASE_URL: "postgres://app_user:x@localhost/form_dev",
      APP_ORIGIN: "http://localhost:3000",
      BETTER_AUTH_SECRET: "super-secret",
      MIGRATOR_DATABASE_URL: "postgres://migrator:x@localhost/form_dev",
      ADMIN_DATABASE_URL: "postgres://postgres:x@localhost/form_dev",
    });
    expect(env["DATABASE_URL"]).toContain("app_user");
    expect(env["BETTER_AUTH_SECRET"]).toBe("super-secret");
    expect(env["MIGRATOR_DATABASE_URL"]).toBeUndefined();
    expect(env["ADMIN_DATABASE_URL"]).toBeUndefined();
  });

  it("gives the worker process only the worker_user URL and heartbeat tuning", () => {
    const env = buildChildEnv("worker", {
      ...BASE,
      WORKER_DATABASE_URL: "postgres://worker_user:x@localhost/form_dev",
      DATABASE_URL: "postgres://app_user:x@localhost/form_dev",
      HEARTBEAT_INTERVAL_MS: "30000",
    });
    expect(env["WORKER_DATABASE_URL"]).toContain("worker_user");
    expect(env["HEARTBEAT_INTERVAL_MS"]).toBe("30000");
    expect(env["DATABASE_URL"]).toBeUndefined();
  });

  it("rejects unknown roles", () => {
    expect(() => buildChildEnv("proxy", BASE)).toThrow(/unknown child role/i);
  });

  it("produces dev defaults matching the documented local ports", () => {
    const d = devDefaults({});
    expect(d.pgPort).toBe("5433");
    expect(d.webPort).toBe("3000");
    expect(d.apiPort).toBe("4000");
    expect(d.appDatabaseUrl).toContain("app_user");
    expect(d.migratorDatabaseUrl).toContain("migrator");
    expect(d.workerDatabaseUrl).toContain("worker_user");
    expect(d.adminDatabaseUrl).toContain("postgres");
    expect(d.apiInternalUrl).toBe("http://127.0.0.1:4000");
  });

  it("derives the dev Better Auth secret for the API child only", () => {
    const d = devDefaults({});
    expect(d.betterAuthSecret).toBe("dev-only-better-auth-secret");
    const web = buildChildEnv("web", { ...BASE, BETTER_AUTH_SECRET: d.betterAuthSecret });
    expect(web["BETTER_AUTH_SECRET"]).toBeUndefined();
    const api = buildChildEnv("api", { ...BASE, BETTER_AUTH_SECRET: d.betterAuthSecret });
    expect(api["BETTER_AUTH_SECRET"]).toBe(d.betterAuthSecret);
  });
});
