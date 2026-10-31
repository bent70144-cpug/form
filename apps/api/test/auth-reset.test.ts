import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  cookieHeaderOf,
  createAuthCoreFixture,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 04 — password reset, end-to-end against real Postgres (embedded
 * fixture on 127.0.0.1:5433) and a real (ephemeral) mail sink. Rate limits
 * are OFF here (the shared fixture default) so the reset flow can sign in
 * freely; the limit behavior lives in auth-rate-limit.test.ts. Covers:
 *
 *   reset request → reset email in the sink → token single-use and 1 h
 *   expiry → completing the reset revokes ALL sessions (401) → sign-in with
 *   the new password → the 12–128 password policy on the new password → the
 *   GENERIC enumeration-safe response for unknown addresses → the GET
 *   callback redirect that hands the token to the web reset page.
 */

const SCRATCH_DB = "t04_auth_reset";
let fx: AuthCoreFixture;
let app: Express;

/** Polls the sink until the RESET mail to `to` arrives (signup also mails). */
async function waitForResetMailTo(to: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { messages } = await fx.mailbox();
    const found = messages.find(
      (m) => m.to.some((t) => t.includes(to)) && m.raw.includes("/v1/auth/reset-password/"),
    );
    if (found) return found.raw;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no reset mail delivered to ${to} within ${timeoutMs}ms`);
}

async function signUp(email: string, password = "password-12-chars-min") {
  const res = await request(app)
    .post("/v1/auth/sign-up/email")
    .set("Origin", fx.appName)
    .send({ name: "Reset User", email, password });
  expect(res.status).toBe(200);
  return res;
}

async function signIn(email: string, password: string) {
  return request(app)
    .post("/v1/auth/sign-in/email")
    .set("Origin", fx.appName)
    .send({ email, password });
}

/** Requests a reset and returns the raw token from the emailed link. */
async function requestResetAndGetToken(email: string): Promise<string> {
  const res = await request(app)
    .post("/v1/auth/request-password-reset")
    .set("Origin", fx.appName)
    .send({ email, redirectTo: `${fx.appName}/reset-password` });
  expect(res.status).toBe(200);
  const raw = await waitForResetMailTo(email);
  const match = raw.match(/\/v1\/auth\/reset-password\/([A-Za-z0-9]+)\?callbackURL=/);
  if (!match) throw new Error(`no reset URL in mail body: ${raw.slice(0, 400)}`);
  return match[1];
}

function completeReset(token: string, newPassword: string) {
  return request(app)
    .post("/v1/auth/reset-password")
    .set("Origin", fx.appName)
    .send({ token, newPassword });
}

async function sessionStatus(cookie: string): Promise<number> {
  const res = await request(app).get("/v1/auth/session").set("Cookie", cookie);
  return res.status;
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;
});

afterAll(async () => {
  await fx.close();
});

describe("password reset request (enumeration-safe)", () => {
  it("delivers a reset email through the mail sink for an existing address", async () => {
    const email = "reset-flow@example.com";
    await signUp(email);

    const res = await request(app)
      .post("/v1/auth/request-password-reset")
      .set("Origin", fx.appName)
      .send({ email, redirectTo: `${fx.appName}/reset-password` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: true });

    const raw = await waitForResetMailTo(email);
    expect(raw).toContain("Subject: Reset your password");
    // The i18n-resolved body embeds the single-use link with a callbackURL.
    expect(raw).toMatch(/\/v1\/auth\/reset-password\/[A-Za-z0-9]+\?callbackURL=/);
    expect(raw).toContain("expires after one hour");
  });

  it("answers the SAME generic body for an unknown address and sends NO mail", async () => {
    await fx.clearMailbox();
    const known = await request(app)
      .post("/v1/auth/request-password-reset")
      .set("Origin", fx.appName)
      .send({ email: "reset-flow@example.com", redirectTo: `${fx.appName}/reset-password` });
    const unknown = await request(app)
      .post("/v1/auth/request-password-reset")
      .set("Origin", fx.appName)
      .send({ email: "who-is-this@example.com", redirectTo: `${fx.appName}/reset-password` });

    expect(unknown.status).toBe(200);
    // Enumeration safety: identical protocol response either way.
    expect(unknown.body).toEqual(known.body);
    // The unknown address must not receive anything (sink has only the known one).
    const { messages } = await fx.mailbox();
    expect(messages.some((m) => m.to.some((t) => t.includes("who-is-this@")))).toBe(false);
  });
});

describe("reset completion — single use, expiry, policy, revocation", () => {
  it("completes a reset: new password signs in, old password rejected", async () => {
    const email = "rotate@example.com";
    await signUp(email, "old-password-123456");
    await signIn(email, "old-password-123456"); // sanity: old password works
    const token = await requestResetAndGetToken(email);

    const res = await completeReset(token, "new-password-654321");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: true });

    expect((await signIn(email, "old-password-123456")).status).toBe(401);
    expect((await signIn(email, "new-password-654321")).status).toBe(200);
  });

  it("a reset token is single-use (second redemption → 400 INVALID_TOKEN)", async () => {
    const email = "single-use@example.com";
    await signUp(email);
    const token = await requestResetAndGetToken(email);
    expect((await completeReset(token, "first-password-123")).status).toBe(200);
    expect((await completeReset(token, "second-password-2")).status).toBe(400);
  });

  it("an expired token (1 h window) is rejected", async () => {
    const email = "expired@example.com";
    await signUp(email);
    const token = await requestResetAndGetToken(email);

    // Fast-forward the token past its one-hour expiry (the row Better Auth
    // created for `reset-password:<token>`).
    await fx.adminClient.query(
      `UPDATE ${"auth"}.verification SET "expiresAt" = now() - interval '1 minute'
       WHERE identifier = $1`,
      [`reset-password:${token}`],
    );

    const res = await completeReset(token, "whatever-password-1");
    expect(res.status).toBe(400);
    expect((await signIn(email, "whatever-password-1")).status).toBe(401);
  });

  it("the new password follows the shared 12–128 policy", async () => {
    const email = "policy@example.com";
    await signUp(email);
    const token = await requestResetAndGetToken(email);

    const tooShort = await completeReset(token, "short-pass1"); // 11 chars
    expect(tooShort.status).toBe(400);
    expect(String((tooShort.body as { code?: string }).code)).toMatch(/^PASSWORD_TOO/);

    // 129 chars — the maxPasswordLength boundary.
    const tooLong = await completeReset(token, "x".repeat(129));
    expect(tooLong.status).toBe(400);
    expect(String((tooLong.body as { code?: string }).code)).toMatch(/^PASSWORD_TOO/);

    // Exactly 128 chars — the upper boundary is accepted.
    expect((await completeReset(token, "x".repeat(128))).status).toBe(200);
    expect((await signIn(email, "x".repeat(128))).status).toBe(200);
  });

  it("completing a reset revokes ALL of the user's sessions (both cookies → 401)", async () => {
    const email = "revoke@example.com";
    await signUp(email, "pre-reset-password-1");

    // Two independent sessions (two devices).
    const deviceA = await signIn(email, "pre-reset-password-1");
    const deviceB = await signIn(email, "pre-reset-password-1");
    const cookieA = cookieHeaderOf(deviceA.headers["set-cookie"]);
    const cookieB = cookieHeaderOf(deviceB.headers["set-cookie"]);
    expect(await sessionStatus(cookieA)).toBe(200);
    expect(await sessionStatus(cookieB)).toBe(200);

    const token = await requestResetAndGetToken(email);
    expect((await completeReset(token, "post-reset-password-1")).status).toBe(200);

    // Both pre-reset sessions are dead — 401 with an empty body.
    const a = await request(app).get("/v1/auth/session").set("Cookie", cookieA);
    const b = await request(app).get("/v1/auth/session").set("Cookie", cookieB);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.text).toBe("");

    // The fresh sign-in after the reset works (cookie from AFTER the reset).
    const fresh = await signIn(email, "post-reset-password-1");
    expect(await sessionStatus(cookieHeaderOf(fresh.headers["set-cookie"]))).toBe(200);
  });
});

describe("GET /v1/auth/reset-password/:token (the emailed link)", () => {
  it("redirects to the web reset page with the token (safe method, no Origin)", async () => {
    const email = "link@example.com";
    await signUp(email);
    const token = await requestResetAndGetToken(email);

    const res = await request(app)
      .get(`/v1/auth/reset-password/${token}`)
      .query({ callbackURL: `${fx.appName}/reset-password` })
      .redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${fx.appName}/reset-password?token=${token}`);
  });

  it("rejects an invalid or used token on the callback", async () => {
    const res = await request(app)
      .get("/v1/auth/reset-password/not-a-real-token")
      .query({ callbackURL: `${fx.appName}/reset-password` })
      .redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=INVALID_TOKEN");
  });
});
