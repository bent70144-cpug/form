import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_WEB_ENV_KEYS,
  WEB_ENV_KEYS,
  WebEnvError,
  loadWebEnv,
} from "../src/lib/env";

/**
 * Web env schema (spec: "The web app has no database URL or auth secret").
 * The whitelist contains ONLY public vars, secret variables make the
 * process refuse to start, and the guard doubles as the lint guard from
 * ticket 01's import-boundary story.
 */
describe("loadWebEnv", () => {
  it("validates a minimal public environment", () => {
    const env = loadWebEnv({ API_INTERNAL_PORT: "4000", NODE_ENV: "production" });
    expect(env).toEqual({
      PORT: 3000,
      NODE_ENV: "production",
      API_INTERNAL_PORT: 4000,
    });
  });

  it("defaults PORT to 3000 and NODE_ENV to development", () => {
    const env = loadWebEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.API_INTERNAL_URL).toBeUndefined();
    expect(env.API_INTERNAL_PORT).toBeUndefined();
  });

  it("accepts the full public surface including the app origin", () => {
    const env = loadWebEnv({
      PORT: "3001",
      NODE_ENV: "development",
      API_INTERNAL_URL: "http://127.0.0.1:4000",
      NEXT_PUBLIC_APP_ORIGIN: "https://form.example",
    });
    expect(env.API_INTERNAL_URL).toBe("http://127.0.0.1:4000");
    expect(env.NEXT_PUBLIC_APP_ORIGIN).toBe("https://form.example");
    expect(env.PORT).toBe(3001);
  });

  it("REFUSES a web process that received the database URL or auth secret", () => {
    expect(() => loadWebEnv({ DATABASE_URL: "postgres://app_user:x@127.0.0.1:5433/db" }))
      .toThrow(/DATABASE_URL/);
    expect(() => loadWebEnv({ BETTER_AUTH_SECRET: "super-secret-value-0123456789" }))
      .toThrow(/BETTER_AUTH_SECRET/);
    expect(() => loadWebEnv({ RESEND_API_KEY: "re_live_k" })).toThrow(/RESEND_API_KEY/);
    expect(() => loadWebEnv({ MIGRATOR_DATABASE_URL: "postgres://migrator:x@h/db" }))
      .toThrow(/MIGRATOR_DATABASE_URL/);
    // All offenders reported together, fail-at-startup style.
    try {
      loadWebEnv({ DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "s" });
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebEnvError);
      expect((err as Error).message).toContain("DATABASE_URL");
      expect((err as Error).message).toContain("BETTER_AUTH_SECRET");
    }
  });

  it("the whitelist itself contains no secret vars", () => {
    expect(WEB_ENV_KEYS).not.toContain("DATABASE_URL");
    expect(WEB_ENV_KEYS).not.toContain("BETTER_AUTH_SECRET");
    expect(FORBIDDEN_WEB_ENV_KEYS).toContain("DATABASE_URL");
    expect(FORBIDDEN_WEB_ENV_KEYS).toContain("BETTER_AUTH_SECRET");
  });

  it("rejects malformed public values (URL, ports, NODE_ENV)", () => {
    expect(() => loadWebEnv({ API_INTERNAL_URL: "not a url" })).toThrow(WebEnvError);
    expect(() => loadWebEnv({ API_INTERNAL_URL: "ftp://127.0.0.1:4000" })).toThrow(WebEnvError);
    expect(() => loadWebEnv({ API_INTERNAL_PORT: "99999" })).toThrow(WebEnvError);
    expect(() => loadWebEnv({ PORT: "zero" })).toThrow(WebEnvError);
    expect(() => loadWebEnv({ NODE_ENV: "staging" })).toThrow(WebEnvError);
  });
});
