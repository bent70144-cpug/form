import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_WEB_ENV_PATTERN,
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
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(FORBIDDEN_WEB_ENV_PATTERN);
    }
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["BETTER_AUTH_SECRET"]).toBeUndefined();
  });

  it("refuses to spawn the web process if a forbidden key would be present", () => {
    // A misconfigured allowlist must fail closed rather than leak.
    // NEXT_PUBLIC_* keys are forwarded to the web child, so a secret hiding
    // under that prefix must trip the fail-closed guard.
    expect(() =>
      buildChildEnv("web", {
        ...BASE,
        NEXT_PUBLIC_DATABASE_URL: "postgres://app_user:x@localhost/db",
      }),
    ).toThrow(/forbidden environment keys/i);
  });

  it("gives the API process the pooled app_user URL but no migrator URL", () => {
    const env = buildChildEnv("api", {
      ...BASE,
      PORT: "4000",
      DATABASE_URL: "postgres://app_user:x@localhost/form_dev",
      APP_ORIGIN: "http://localhost:3000",
      MIGRATOR_DATABASE_URL: "postgres://migrator:x@localhost/form_dev",
      ADMIN_DATABASE_URL: "postgres://postgres:x@localhost/form_dev",
    });
    expect(env["DATABASE_URL"]).toContain("app_user");
    expect(env["MIGRATOR_DATABASE_URL"]).toBeUndefined();
    expect(env["ADMIN_DATABASE_URL"]).toBeUndefined();
  });

  it("gives the worker process only the worker_user URL", () => {
    const env = buildChildEnv("worker", {
      ...BASE,
      WORKER_DATABASE_URL: "postgres://worker_user:x@localhost/form_dev",
      DATABASE_URL: "postgres://app_user:x@localhost/form_dev",
    });
    expect(env["WORKER_DATABASE_URL"]).toContain("worker_user");
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
  });
});
