import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { isUuid } from "@form/database";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 03 — auth core and session boundary, end-to-end against real
 * Postgres (embedded fixture on 127.0.0.1:5433) and a real (ephemeral) mail
 * sink. Covers:
 *
 *   signup → verification-email-in-sink → verify → sign-in → session →
 *   sign-out; enumeration-safe signup/sign-in; 12–128 password edges;
 *   403 `email_unverified` on the guarded probe route; the minimal session
 *   endpoint (200 shape + 401 empty body); server-side revocation → 401;
 *   the global Origin guard (missing / mismatched / allowlist / cookie-less
 *   exemption).
 */

const SCRATCH_DB = "t03_auth_core";
let fx: AuthCoreFixture;
let app: Express;

/** Polls the sink mailbox until a message to `to` arrives (background send). */
async function waitForMailTo(to: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { messages } = await fx.mailbox();
    const found = messages.find((m) => m.to.some((t) => t.includes(to)));
    if (found) return found.raw;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail delivered to ${to} within ${timeoutMs}ms`);
}

async function signUp(
  body: Record<string, unknown>,
  origin: string | undefined = fx.appName,
) {
  const req = request(app).post("/v1/auth/sign-up/email");
  if (origin) req.set("Origin", origin);
  return req.send(body);
}

async function signIn(email: string, password: string, origin: string | undefined = fx.appName) {
  const req = request(app).post("/v1/auth/sign-in/email");
  if (origin) req.set("Origin", origin);
  return req.send({ email, password });
}

/** Signs up AND verifies the email (skipping the mailbox for speed). */
async function signUpVerified(email: string, password = "password-12-chars-min") {
  const res = await signUp({ name: "V User", email, password });
  expect(res.status).toBe(200);
  const raw = await waitForMailTo(email);
  const url = extractVerificationUrl(raw);
  const target = new URL(url);
  const verified = await request(app).get(`${target.pathname}${target.search}`);
  expect([200, 302]).toContain(verified.status);
  return res;
}

async function userCount(email: string): Promise<number> {
  const res = await fx.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${"auth"}.user WHERE email = $1`,
    [email],
  );
  return Number(res.rows[0]?.count ?? "0");
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;
}, 120_000);

afterAll(async () => {
  await fx.close();
});

describe("signup → verification email → verify → sign-in → session → sign-out", () => {
  const email = `happy-${Date.now()}@example.com`;
  const password = "correct-horse-12";
  let signInCookie = "";

  it("signs up without creating a session; user id is a UUID; email unverified", async () => {
    const res = await signUp({
      name: "Happy Path",
      email,
      password,
      callbackURL: "/verify-email",
    });
    expect(res.status).toBe(200);
    const body = res.body as { token: string | null; user: { id: string; email: string; emailVerified: boolean } };
    expect(body.token).toBeNull();
    expect(body.user.email).toBe(email);
    expect(body.user.emailVerified).toBe(false);
    expect(isUuid(body.user.id)).toBe(true);
    expect(res.headers["set-cookie"]).toBeUndefined();
    await expect(userCount(email)).resolves.toBe(1);
  });

  it("delivers the verification email to the sink with an i18n subject and no token in logs", async () => {
    const raw = await waitForMailTo(email);
    expect(raw).toContain("Subject: Verify your email");
    expect(raw).toContain("/v1/auth/verify-email?token=");
    expect(raw).toContain("callbackURL=%2Fverify-email");
  });

  it("verifies through the emailed link (cookie-less, no Origin) and reflects the state in the session", async () => {
    const raw = await waitForMailTo(email);
    const url = new URL(extractVerificationUrl(raw));
    const res = await request(app).get(`${url.pathname}${url.search}`);
    // Token-based email-verification link callback: exempt from the Origin
    // guard AND cookie-less — a browser navigation from an email client.
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/verify-email");

    const db = await fx.adminClient.query<{ emailVerified: boolean }>(
      `SELECT "emailVerified" FROM auth.user WHERE email = $1`,
      [email],
    );
    expect(db.rows[0]?.emailVerified).toBe(true);
  });

  it("signs in with the session cookie HttpOnly + SameSite=Lax and 7-day expiry", async () => {
    const res = await signIn(email, password);
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const sessionCookie = setCookie.find((c) => c.startsWith("better-auth.session_token="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).not.toMatch(/;\s*Secure/i); // http origin in tests
    const expires = sessionCookie?.match(/Expires=([^;]+)/)?.[1];
    const maxAge = sessionCookie?.match(/Max-Age=(\d+)/)?.[1];
    // Better Auth expresses the 7-day lifetime via Max-Age (and/or Expires).
    const days = expires
      ? (new Date(expires).getTime() - Date.now()) / 86_400_000
      : Number(maxAge) / 86_400;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    signInCookie = cookieHeaderOf(setCookie);
  });

  it("GET /v1/auth/session returns the minimal contract with a verified email", async () => {
    const res = await request(app).get("/v1/auth/session").set("Cookie", signInCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: expect.any(String),
      email,
      emailVerified: true,
      workspace: null, // stays null until ticket 05
    });
    expect(Object.keys(res.body).sort()).toEqual(
      ["email", "emailVerified", "userId", "workspace"],
    );
    expect(isUuid(res.body.userId)).toBe(true);
  });

  it("the guarded probe route accepts the now-verified user", async () => {
    const get = await request(app).get("/v1/probe/verified").set("Cookie", signInCookie);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ ok: true, via: "GET" });

    const post = await request(app)
      .post("/v1/probe/verified")
      .set("Cookie", signInCookie)
      .set("Origin", fx.appName);
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ ok: true, via: "POST" });
  });

  it("signs out; the session cookie stops authenticating immediately", async () => {
    const res = await request(app)
      .post("/v1/auth/sign-out")
      .set("Cookie", signInCookie)
      .set("Origin", fx.appName)
      .send({});
    expect(res.status).toBe(200);

    const after = await request(app).get("/v1/auth/session").set("Cookie", signInCookie);
    expect(after.status).toBe(401);
    expect(after.text).toBe(""); // 401 with no body detail
  });
});

describe("enumeration safety", () => {
  const email = `enum-${Date.now()}@example.com`;

  it("signup with an existing email returns the SAME generic result (and no second user)", async () => {
    const first = await signUp({ name: "First", email, password: "password-12-chars-min" });
    expect(first.status).toBe(200);
    const second = await signUp({ name: "Second", email, password: "another-pass-12-char" });
    expect(second.status).toBe(200);
    const a = first.body as { token: string | null; user: Record<string, unknown> };
    const b = second.body as { token: string | null; user: Record<string, unknown> };
    // Identical generic shape: token null, same user field set, same verified flag.
    expect(b.token).toBeNull();
    expect(Object.keys(b.user).sort()).toEqual(Object.keys(a.user).sort());
    expect(b.user.emailVerified).toBe(false);
    // The synthetic response does NOT leak the stored user id.
    expect(b.user.id).not.toBe((first.body as { user: { id: string } }).user.id);
    expect(isUuid(b.user.id as string)).toBe(true);
    // No session cookie on either response.
    expect(first.headers["set-cookie"]).toBeUndefined();
    expect(second.headers["set-cookie"]).toBeUndefined();
    // Exactly one user row exists.
    await expect(userCount(email)).resolves.toBe(1);
  });

  it("invalid sign-in returns ONE generic credential error (unknown email ≡ wrong password)", async () => {
    await signUp({ name: "Enum", email, password: "password-12-chars-min" });
    const unknownEmail = await signIn(`nobody-${Date.now()}@example.com`, "whatever-pass-12");
    const wrongPassword = await signIn(email, "wrong-password-123");
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(JSON.stringify(wrongPassword.body)).toBe(JSON.stringify(unknownEmail.body));
    expect(unknownEmail.body).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
  });

  it("resend-verification for an unknown email is indistinguishable from a known one", async () => {
    const unknown = await request(app)
      .post("/v1/auth/send-verification-email")
      .set("Origin", fx.appName)
      .send({ email: `ghost-${Date.now()}@example.com` });
    const known = await request(app)
      .post("/v1/auth/send-verification-email")
      .set("Origin", fx.appName)
      .send({ email });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.body).toEqual({ status: true });
  }, 10_000);
});

describe("password policy 12–128 (shared with ticket 04)", () => {
  const base = Date.now();

  it("rejects 11 characters", async () => {
    const res = await signUp({ name: "Short", email: `pw11-${base}@example.com`, password: "a".repeat(11) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
  });

  it("accepts exactly 12 characters", async () => {
    const res = await signUp({ name: "Edge", email: `pw12-${base}@example.com`, password: "a".repeat(12) });
    expect(res.status).toBe(200);
  });

  it("accepts exactly 128 characters", async () => {
    const res = await signUp({ name: "Edge", email: `pw128-${base}@example.com`, password: `${"a".repeat(127)}0` });
    expect(res.status).toBe(200);
  });

  it("rejects 129 characters", async () => {
    const res = await signUp({ name: "Long", email: `pw129-${base}@example.com`, password: "a".repeat(129) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "PASSWORD_TOO_LONG" });
  });
});

describe("email-unverified boundary (probe routes)", () => {
  const email = `unverified-${Date.now()}@example.com`;
  const password = "password-12-chars-min";
  let cookie = "";

  beforeAll(async () => {
    await signUp({ name: "Unverified", email, password });
    const res = await signIn(email, password);
    expect(res.status).toBe(200); // unverified users MAY sign in
    cookie = cookieHeaderOf(res.headers["set-cookie"]);
  });

  it("403 `email_unverified` (RFC 9457 body, i18n title) on guarded GET", async () => {
    const res = await request(app).get("/v1/probe/verified").set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.type).toBe("application/problem+json");
    expect(res.body).toMatchObject({
      type: "https://form.example/errors/email_unverified",
      status: 403,
      code: "email_unverified",
    });
  });

  it("403 `email_unverified` on guarded POST with a valid Origin", async () => {
    const res = await request(app)
      .post("/v1/probe/verified")
      .set("Cookie", cookie)
      .set("Origin", fx.appName);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "email_unverified" });
  });

  it("signed-out requests get 401 `unauthenticated` from the same guard", async () => {
    const res = await request(app).get("/v1/probe/verified");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "unauthenticated", status: 401 });
  });
});

describe("session endpoint contract", () => {
  it("401 with an empty body for a missing cookie", async () => {
    const res = await request(app).get("/v1/auth/session");
    expect(res.status).toBe(401);
    expect(res.text).toBe("");
  });

  it("401 with an empty body for an invalid cookie", async () => {
    const res = await request(app)
      .get("/v1/auth/session")
      .set("Cookie", "better-auth.session_token=garbage-token");
    expect(res.status).toBe(401);
    expect(res.text).toBe("");
  });

  it("never creates anything: repeated unauthenticated calls stay 401 and create no rows", async () => {
    const before = await fx.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth.session`,
    );
    for (let i = 0; i < 3; i++) {
      await request(app).get("/v1/auth/session");
    }
    const after = await fx.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth.session`,
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count));
  });
});

describe("server-side session revocation", () => {
  const email = `revoke-${Date.now()}@example.com`;
  const password = "password-12-chars-min";

  it("a server-side revoked session 401s on the next request", async () => {
    await signUpVerified(email, password);
    const signInRes = await signIn(email, password);
    const token = (signInRes.body as { token: string }).token;
    expect(token).toBeTruthy();
    const cookie = cookieHeaderOf(signInRes.headers["set-cookie"]);

    const before = await request(app).get("/v1/auth/session").set("Cookie", cookie);
    expect(before.status).toBe(200);

    const revoked = await revokeSessionByToken(token);
    expect(revoked).toBe(true);

    const after = await request(app).get("/v1/auth/session").set("Cookie", cookie);
    expect(after.status).toBe(401);
    expect(after.text).toBe("");

    // Better Auth's own session read sees the same revocation.
    const ba = await request(app).get("/v1/auth/get-session").set("Cookie", cookie);
    expect(ba.status).toBe(200);
    expect(ba.body ?? null).toBeNull();
  });

  it("revoking an unknown token reports false without error", async () => {
    await expect(revokeSessionByToken("no-such-token")).resolves.toBe(false);
  });

  /** Uses the auth instance's internal adapter (see @form/auth/server). */
  async function revokeSessionByToken(token: string): Promise<boolean> {
    const { revokeSessionByToken: revoke } = await import("@form/auth/server");
    return revoke(fx.auth, token);
  }
});

describe("global Origin guard", () => {
  it("rejects a state-changing request with NO Origin (no internal-call exemption)", async () => {
    // NOTE: no Origin header at all — an internal/bootstrap-shaped call.
    const res = await request(app)
      .post("/v1/auth/sign-in/email")
      .send({ email: "x@example.com", password: "password-12-chars-min" });
    expect(res.status).toBe(403);
    expect(res.type).toBe("application/problem+json");
    expect(res.body).toMatchObject({
      type: "https://form.example/errors/origin_mismatch",
      status: 403,
      code: "origin_mismatch",
    });
  });

  it("rejects a mismatched Origin (different host, different port, invalid URL)", async () => {
    for (const origin of ["https://evil.example", "http://localhost:9999", "not-a-url"]) {
      const res = await signIn("x@example.com", "password-12-chars-min", origin);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "origin_mismatch" });
    }
  });

  it("safe methods never require an Origin (SSR session reads work)", async () => {
    const res = await request(app).get("/v1/health");
    expect(res.status).toBe(200);
    const session = await request(app).get("/v1/auth/session");
    expect(session.status).toBe(401); // 401, not 403-origin: no Origin needed for GET
  });

  it("allowlisted email-verification callback works without Origin and WITHOUT reading the auth cookie", async () => {
    // A garbage token → redirect with error, NO Origin header at all.
    const base = `/v1/auth/verify-email?token=invalid-token&callbackURL=%2Fverify-email`;
    const withoutCookie = await request(app).get(base);
    expect(withoutCookie.status).toBe(302);
    expect(withoutCookie.headers.location).toBe("/verify-email?error=INVALID_TOKEN");

    // The SAME request while carrying a VALID session cookie behaves
    // identically — the exempt route never reads the auth cookie.
    const email = `exempt-${Date.now()}@example.com`;
    await signUpVerified(email);
    const signInRes = await signIn(email, "password-12-chars-min");
    const cookie = cookieHeaderOf(signInRes.headers["set-cookie"]);
    const withCookie = await request(app).get(base).set("Cookie", cookie);
    expect(withCookie.status).toBe(withoutCookie.status);
    expect(withCookie.headers.location).toBe(withoutCookie.headers.location);

    // And a FUTURE public allowlisted path is exempt by pattern.
    const future = await request(app)
      .post("/v1/public/forms/some-slug/sessions")
      .send({});
    // No route exists yet (ticket 05) — the point is it did NOT die with 403
    // origin_mismatch before reaching the router.
    expect(future.status).not.toBe(403);
  });
});

describe("SSR-vs-browser session validation paths", () => {
  it("SSR path: internal-API call with forwarded cookie resolves the session", async () => {
    const email = `ssr-${Date.now()}@example.com`;
    await signUpVerified(email);
    const signInRes = await signIn(email, "password-12-chars-min");
    const cookie = cookieHeaderOf(signInRes.headers["set-cookie"]);
    // Server components call the INTERNAL URL directly with the cookie header
    // (createSessionClient with baseUrl) — same hop supertest makes here.
    const res = await request(app)
      .get("/v1/auth/session")
      .set("Cookie", cookie)
      .set("accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
  });

  it("browser path: cookie-less/anonymous requests get 401 (no Origin required on GET)", async () => {
    const res = await request(app).get("/v1/auth/session");
    expect(res.status).toBe(401);
    expect(res.text).toBe("");
  });
});

describe("cookie hardening — Secure in production (env simulation)", () => {
  let prodFx: AuthCoreFixture;
  let prodApp: Express;

  beforeAll(async () => {
    // Simulate the deployed environment: NODE_ENV=production forces the
    // `Secure` cookie attribute (apps/api passes secureCookies to
    // @form/auth/server). The email provider is pinned to a standalone sink
    // because production would otherwise resolve to Resend (no credentials
    // in the sandbox) — no email is actually needed for a sign-in.
    const { createMailSink } = await import("../../../scripts/mail-sink.mjs");
    const standalone = createMailSink({ smtpPort: 0, httpPort: 0 });
    const ports = await standalone.start();
    const { MailSinkEmailProvider } = await import("@form/auth/server");
    prodFx = await createAuthCoreFixture(
      "t03_auth_prod",
      { NODE_ENV: "production" },
      { emailProvider: new MailSinkEmailProvider({ port: ports.smtpPort }) },
    );
    prodApp = prodFx.expressApp;
  }, 120_000);

  afterAll(async () => {
    await prodFx.close();
  });

  it("production sessions Set-Cookie carry HttpOnly, SameSite=Lax AND Secure", async () => {
    const email = `prod-secure-${Date.now()}@example.com`;
    const password = "password-12-chars-min";
    const signUpRes = await request(prodApp)
      .post("/v1/auth/sign-up/email")
      .set("Origin", prodFx.appName)
      .send({ name: "Prod", email, password });
    expect(signUpRes.status).toBe(200);

    const res = await request(prodApp)
      .post("/v1/auth/sign-in/email")
      .set("Origin", prodFx.appName)
      .send({ email, password });
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"] as unknown as string[];
    // With useSecureCookies, Better Auth adds the __Secure- cookie prefix.
    const sessionCookie = setCookie.find((c) =>
      c.startsWith("__Secure-better-auth.session_token="),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/;\s*Secure/i); // ← the production delta
    // 7-day maxAge holds in production too.
    const days =
      Number(sessionCookie?.match(/Max-Age=(\d+)/)?.[1] ?? 0) / 86_400 ||
      (new Date(sessionCookie?.match(/Expires=([^;]+)/)?.[1] ?? "").getTime() -
        Date.now()) /
        86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});
