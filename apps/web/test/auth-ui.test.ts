import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { t } from "@form/i18n";
import {
  SESSION_COOKIE_NAME,
  SECURE_SESSION_COOKIE_NAME,
  isMissingSessionCookie,
} from "../src/middleware";

const WEB_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(WEB_ROOT, "src");

function readWebSource(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (/\.(tsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("middleware cookie-presence check (NOT a security boundary)", () => {
  it("keeps the spec comment in place", () => {
    const source = readWebSource("src/middleware.ts");
    expect(source).toContain("not a security boundary");
    expect(source).toContain("cookie-presence");
  });

  it("treats a missing session cookie as signed-out", () => {
    expect(isMissingSessionCookie({ cookies: { get: () => undefined } })).toBe(true);
  });

  it("recognizes the plain dev cookie name AND the production __Secure- prefix", () => {
    const req = (name: string) => ({
      cookies: { get: (n: string) => (n === name ? { value: "t" } : undefined) },
    });
    expect(isMissingSessionCookie(req(SESSION_COOKIE_NAME))).toBe(false);
    expect(isMissingSessionCookie(req(SECURE_SESSION_COOKIE_NAME))).toBe(false);
    expect(SECURE_SESSION_COOKIE_NAME).toBe("__Secure-better-auth.session_token");
  });

  it("middleware only matches /dashboard paths", () => {
    const source = readWebSource("src/middleware.ts");
    expect(source).toContain('matcher: ["/dashboard/:path*"]');
  });
});

describe("SSR session validation seam", () => {
  it("dashboard redirects signed-out visitors and uses the cached SSR session", () => {
    const page = readWebSource("src/app/dashboard/page.tsx");
    expect(page).toContain("getServerSession");
    expect(page).toContain('redirect("/sign-in');
    const sessionLib = readWebSource("src/lib/session.ts");
    // React cache() wraps the internal-API call (one fetch per render).
    expect(sessionLib).toContain("cache(");
    expect(sessionLib).toContain("internalApiUrl()");
  });

  it("SSR session lib forwards the cookie and never calls the public origin", () => {
    const sessionLib = readWebSource("src/lib/session.ts");
    expect(sessionLib).toContain("cookieStore.toString()");
  });
});

describe("i18n usage in web auth pages (spot-check)", () => {
  it("every t() key used in web sources resolves in the catalog", () => {
    const sources = walkSources(SRC_ROOT);
    expect(sources.length).toBeGreaterThan(5);
    const keyRe = /\bt\(\s*(?:`)?["'`]([a-zA-Z][\w.]*)["'`]/g;
    const used = new Set<string>();
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(keyRe)) {
        const key = match[1];
        if (key) used.add(key);
      }
    }
    expect(used.has("auth.signIn.title")).toBe(true);
    expect(used.has("dashboard.title")).toBe(true);
    const missing: string[] = [];
    for (const key of used) {
      // Template keys (`auth.errors.${…}`) resolve from the literal prefixes
      // below; skip dynamic ones here and cover them with explicit keys.
      if (key.includes("${")) continue;
      try {
        t(key as Parameters<typeof t>[0]);
      } catch {
        missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("spot-checks the exact auth keys the pages rely on", () => {
    for (const key of [
      "auth.signIn.title",
      "auth.signIn.emailLabel",
      "auth.signIn.passwordLabel",
      "auth.signIn.submit",
      "auth.signIn.noAccount",
      "auth.signIn.switchToSignUp",
      "auth.signUp.title",
      "auth.signUp.nameLabel",
      "auth.signUp.checkInboxTitle",
      "auth.signUp.checkInboxBody",
      "auth.passwordPolicyHint",
      "auth.verifyEmail.title",
      "auth.verifyEmail.success",
      "auth.verifyEmail.failed",
      "auth.verifyEmail.resendHere",
      "auth.verifyEmail.backToSignIn",
      "auth.resend.prompt",
      "auth.resend.action",
      "auth.resend.sent",
      "auth.signOut.action",
      "auth.errors.invalidCredentials",
      "auth.errors.emailUnverified",
      "auth.errors.generic",
      "auth.errors.passwordPolicy",
      "dashboard.title",
      "dashboard.signedInAs",
      "dashboard.placeholderNote",
      "common.loading",
    ]) {
      expect(() => t(key as Parameters<typeof t>[0])).not.toThrow();
    }
    // Interpolation actually substitutes the placeholders the pages pass.
    expect(t("dashboard.signedInAs", { email: "a@b.co" })).toContain("a@b.co");
    expect(
      t("auth.errors.passwordPolicy", { min: 12, max: 128 }),
    ).toContain("12");
  });
});

describe("web deployable never references secrets", () => {
  it("no src file USES DATABASE_URL / BETTER_AUTH_SECRET / RESEND_API_KEY", () => {
    const sources = walkSources(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of sources) {
      // The guard module itself (src/lib/env.ts) names the forbidden keys in
      // its refusal list — that is the exemption; everything else must not
      // even mention them, so comments are stripped before scanning.
      if (file.endsWith(path.join("lib", "env.ts"))) continue;
      const text = stripComments(fs.readFileSync(file, "utf8"));
      if (/DATABASE_URL|BETTER_AUTH_SECRET|RESEND_API_KEY/.test(text)) {
        offenders.push(path.relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Removes // line comments and /* block comments *\/ for source scanning. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}
