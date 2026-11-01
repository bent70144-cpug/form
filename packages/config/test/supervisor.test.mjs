import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_WEB_ENV_PATTERN,
  ROLE_ALLOWLISTS,
  SYSTEM_KEYS,
  buildChildEnv,
  devDefaults,
} from "../../../scripts/supervisor.mjs";

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

  // --- ticket 12: migration/admin credentials never reach any child process ---

  it("NEVER passes the migrator or admin URL to any child — they live only in the GitHub Actions migrate job", () => {
    const hostile = {
      ...BASE,
      MIGRATOR_DATABASE_URL: "postgres://migrator:pw@host/db",
      ADMIN_DATABASE_URL: "postgres://admin:pw@host/db",
    };
    for (const role of Object.keys(ROLE_ALLOWLISTS)) {
      const env = buildChildEnv(role, hostile);
      expect(env["MIGRATOR_DATABASE_URL"], role).toBeUndefined();
      expect(env["ADMIN_DATABASE_URL"], role).toBeUndefined();
    }
    for (const [role, allow] of Object.entries(ROLE_ALLOWLISTS)) {
      expect(allow, role).not.toContain("MIGRATOR_DATABASE_URL");
      expect(allow, role).not.toContain("ADMIN_DATABASE_URL");
    }
  });

  it("gives the worker NO secrets — only the worker_user URL, LOG_LEVEL and heartbeat tuning", () => {
    const env = buildChildEnv("worker", {
      ...BASE,
      WORKER_DATABASE_URL: "postgres://worker_user:pw@host/db",
      // everything else that exists in the deploy environment must not leak in
      DATABASE_URL: "postgres://app_user:pw@host/db",
      BETTER_AUTH_SECRET: "super-secret",
      APP_ORIGIN: "http://localhost:3000",
      RESEND_API_KEY: "re_secret",
      IP_HASH_SECRET: "0123456789abcdef",
      EMAIL_FROM: "noreply@example.com",
      TRUSTED_PROXY_COUNT: "1",
    });
    expect(env["WORKER_DATABASE_URL"]).toContain("worker_user");
    for (const forbidden of [
      "BETTER_AUTH_SECRET",
      "APP_ORIGIN",
      "DATABASE_URL",
      "RESEND_API_KEY",
      "IP_HASH_SECRET",
      "EMAIL_FROM",
      "TRUSTED_PROXY_COUNT",
      "MIGRATOR_DATABASE_URL",
      "ADMIN_DATABASE_URL",
    ]) {
      expect(env[forbidden], forbidden).toBeUndefined();
    }
    // the worker env is EXACTLY system keys + its allowlist — nothing else
    const allowed = new Set([
      ...SYSTEM_KEYS,
      "WORKER_DATABASE_URL",
      "LOG_LEVEL",
      "HEARTBEAT_INTERVAL_MS",
    ]);
    for (const key of Object.keys(env)) {
      expect(allowed.has(key), key).toBe(true);
    }
  });

  it("forwards the API's production email/proxy variables to the API child but never to the web child", () => {
    const production = {
      ...BASE,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_live_key",
      EMAIL_FROM: "noreply@example.com",
      TRUSTED_PROXY_COUNT: "1",
      IP_HASH_SECRET: "0123456789abcdef",
      FORM_SUBMISSION_CAP: "1000",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
    };
    const api = buildChildEnv("api", production);
    for (const key of Object.keys(production).filter((k) => !k.startsWith("NODE"))) {
      expect(api[key], key).toBe(production[key]);
    }
    // The web child never sees ANY of them — the allowlist drops every key
    // it does not name, so these are simply absent from the spawned env.
    const web = buildChildEnv("web", production);
    for (const key of [
      "EMAIL_PROVIDER",
      "RESEND_API_KEY",
      "EMAIL_FROM",
      "TRUSTED_PROXY_COUNT",
      "IP_HASH_SECRET",
      "FORM_SUBMISSION_CAP",
      "SMTP_HOST",
      "SMTP_PORT",
    ]) {
      expect(web[key], key).toBeUndefined();
    }
    // NEXT_PUBLIC_* forwarding cannot smuggle a secret into the browser
    // deployable either: the fail-closed sweep refuses the spawn.
    expect(() =>
      buildChildEnv("web", { ...BASE, NEXT_PUBLIC_RESEND_API_KEY: "re_x" }),
    ).toThrow(/forbidden environment keys/i);
  });

  it("treats any *API_KEY as forbidden for the web child (pattern sweep)", () => {
    expect(FORBIDDEN_WEB_ENV_PATTERN.test("RESEND_API_KEY")).toBe(true);
    // A NEXT_PUBLIC_-prefixed API key WOULD be forwarded to the browser build;
    // the sweep must refuse the spawn instead.
    expect(() =>
      buildChildEnv("web", { ...BASE, NEXT_PUBLIC_STRIPE_API_KEY: "sk_live_x" }),
    ).toThrow(/forbidden environment keys/i);
  });
});
