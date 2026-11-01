import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { Pool } from "pg";
import { createHash, createHmac } from "node:crypto";
import { BLOCK_ID_RE, emptyDraft, type FormSchema } from "@form/form-schema";
import {
  purgeExpiredSessionsOnce,
} from "../src/public/purge";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 10 API slice — public session creation, end-to-end over the real
 * HTTP stack (supertest against createApiApp, embedded Postgres, REAL roles):
 *
 *   POST /v1/public/forms/{slug}/sessions
 *     - resolves through the security-definer resolve_public_form(slug) —
 *       only PUBLISHED non-deleted forms; 404 otherwise;
 *     - returns the RAW token ONCE (base64url of 32 random bytes); only its
 *       SHA-256 hash is stored; the session pins the published version for
 *       24h;
 *     - stores an HMAC-SHA256 of the trusted client IP (never reversible)
 *       and the user agent;
 *     - rate-limited 30/hour per IP AND per form; spoofed forwarded headers
 *       cannot mint fresh buckets (TRUSTED_PROXY_COUNT=0 locally — the peer
 *       address is the only input);
 *     - the route is cookie-less: no auth cookie, no Origin requirement, and
 *       a forged X-Workspace-Id header is ignored (the workspace comes from
 *       the resolved form).
 *
 * Plus the worker purge seam: purge_expired_sessions() runs as worker_user,
 * deletes sessions expired for >7 days, and direct worker_user SELECTs on
 * form_sessions are denied (42501).
 */

const SCRATCH_DB = "t10_sessions_api";
let fx: AuthCoreFixture;
let app: Express;
let admin: AuthCoreFixture["adminClient"];

let userSeq = 0;

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

async function newWorkspaceUser(
  prefix: string,
): Promise<{ email: string; cookie: string; workspaceId: string }> {
  // This suite runs with the ticket-04 limits ON (the session rate-limit
  // tests need them). User bootstrap would trip the per-IP sign-up limit, so
  // clear the shared limiter first — each rate-limit test below resets again
  // before driving its own 30-attempt run.
  fx.rateLimiter.reset();
  userSeq += 1;
  const email = `${prefix}-${Date.now()}-${userSeq}@t10.example`;
  const signedUp = await request(app)
    .post("/v1/auth/sign-up/email")
    .set("Origin", fx.appName)
    .send({ name: "T10 User", email, password: "correct-horse-12", callbackURL: "/dashboard" });
  expect(signedUp.status).toBe(200);
  const raw = await waitForMailTo(email);
  const url = new URL(extractVerificationUrl(raw));
  const verified = await request(app).get(`${url.pathname}${url.search}`);
  expect([200, 302]).toContain(verified.status);
  const signIn = await request(app)
    .post("/v1/auth/sign-in/email")
    .set("Origin", fx.appName)
    .send({ email, password: "correct-horse-12" });
  expect(signIn.status).toBe(200);
  const cookie = cookieHeaderOf(signIn.headers["set-cookie"]);
  const bootstrapped = await request(app)
    .post("/v1/workspaces/bootstrap")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(bootstrapped.status).toBe(200);
  return { email, cookie, workspaceId: bootstrapped.body.workspace.id as string };
}

function bid(n: number): string {
  const id = `b${String(n).padStart(11, "0")}`;
  expect(id).toMatch(BLOCK_ID_RE);
  return id;
}

/** Minimal publishable envelope: welcome → required question → ending. */
function publishableEnvelope(): FormSchema {
  return {
    ...emptyDraft(),
    title: "Client intake",
    blocks: [
      { id: bid(1), kind: "welcome", title: "Welcome" },
      { id: bid(2), kind: "short_text", label: "Full name", required: true },
      { id: bid(3), kind: "ending", title: "Thanks!" },
    ],
  } as FormSchema;
}

interface PublishedForm {
  formId: string;
  slug: string;
  versionId: string;
  schema: FormSchema;
}

async function publishForm(
  cookie: string,
  schema: FormSchema = publishableEnvelope(),
): Promise<PublishedForm> {
  const created = await request(app)
    .post("/v1/forms")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(created.status).toBe(201);
  const formId = created.body.id as string;
  const saved = await request(app)
    .put(`/v1/forms/${formId}/draft`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send({ schema: schema as unknown, draftVersion: 0 });
  expect(saved.status).toBe(200);
  const published = await request(app)
    .post(`/v1/forms/${formId}/publish`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(published.status).toBe(200);
  return {
    formId,
    slug: published.body.slug as string,
    versionId: published.body.versionId as string,
    schema,
  };
}

function createSession(
  slug: string,
  options: { headers?: Record<string, string> } = {},
) {
  const req = request(app).post(`/v1/public/forms/${slug}/sessions`);
  // Origin-EXEMPT route: by default NO Origin header is sent at all — the
  // request must succeed cookie-less and origin-less.
  for (const [k, v] of Object.entries(options.headers ?? {})) req.set(k, v);
  return req.send();
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(
    SCRATCH_DB,
    {
      IP_HASH_SECRET: "ip-hash-secret-0123456789abcdef",
      TRUSTED_PROXY_COUNT: "0", // local topology: the socket peer is the client
    },
    { rateLimits: { enabled: true } },
  );
  app = fx.expressApp;
  admin = fx.adminClient;
});

afterAll(async () => {
  await fx.close();
});

describe("POST /v1/public/forms/{slug}/sessions (ticket 10)", () => {
  it("creates a pinned session: raw token once, sha256 hash stored, 24h expiry, pinned version + snapshot", async () => {
    const user = await newWorkspaceUser("session-owner");
    const form = await publishForm(user.cookie);

    const res = await createSession(form.slug);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = res.body as {
      token: string;
      expiresAt: string;
      pinnedVersionId: string;
      schema: unknown;
    };
    // 32 random bytes → 43 base64url chars.
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.pinnedVersionId).toBe(form.versionId);
    expect(body.schema).toEqual(form.schema);

    const expires = new Date(body.expiresAt).getTime();
    const dayMs = 24 * 3600 * 1000;
    expect(Math.abs(expires - (Date.now() + dayMs))).toBeLessThan(60_000);

    // Only the SHA-256 hash is stored — never the raw token.
    const rows = await admin.query<{
      token_hash: string;
      expires_at: Date;
      form_version_id: string;
      ip_hash: string | null;
      user_agent: string | null;
    }>(
      `SELECT token_hash, expires_at, form_version_id::text, ip_hash, user_agent
         FROM app.form_sessions WHERE token_hash = $1`,
      [createHash("sha256").update(body.token).digest("hex")],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.token_hash).not.toBe(body.token);
    expect(row.form_version_id).toBe(form.versionId);
    expect(Math.abs(row.expires_at.getTime() - (Date.now() + dayMs))).toBeLessThan(60_000);
    // Stored IP metadata is the keyed HMAC (64 hex chars) — NOT a plain hash
    // of the address, and reproducible only with the server secret.
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ip_hash).not.toBe(createHash("sha256").update("127.0.0.1").digest("hex"));
    expect(row.ip_hash).toBe(
      createHmac("sha256", "ip-hash-secret-0123456789abcdef").update("127.0.0.1").digest("hex"),
    );
  });

  it("answers 404 for unknown slugs and for forms that are not published", async () => {
    const missing = await createSession("zzzzzzzzzz");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");

    // A never-published (draft) form has no slug at all — resolve_public_form
    // only resolves PUBLISHED forms, so any unresolvable slug is 404, never
    // the closed message (that is the render path's contract).
    const draftOnly = await createSession("zzzzzzzzzy");
    expect(draftOnly.status).toBe(404);
  });

  it("ignores a forged X-Workspace-Id header — the workspace comes from the resolved form", async () => {
    const user = await newWorkspaceUser("session-forged");
    const form = await publishForm(user.cookie);
    const forged = "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b";

    const res = await createSession(form.slug, {
      headers: { "X-Workspace-Id": forged },
    });
    expect(res.status).toBe(200);

    const rows = await admin.query<{ workspace_id: string }>(
      `SELECT workspace_id::text FROM app.form_sessions WHERE token_hash = $1`,
      [createHash("sha256").update(res.body.token as string).digest("hex")],
    );
    expect(rows.rows[0]!.workspace_id).toBe(user.workspaceId);
    expect(rows.rows[0]!.workspace_id).not.toBe(forged);
  });

  it("rate-limits session creation to 30/hour per IP and per form (31st → 429)", async () => {
    const user = await newWorkspaceUser("session-limited");
    const form = await publishForm(user.cookie);

    fx.rateLimiter.reset();
    for (let i = 0; i < 30; i += 1) {
      const res = await createSession(form.slug);
      expect(res.status).toBe(200);
    }
    const exceeded = await createSession(form.slug);
    expect(exceeded.status).toBe(429);
    expect(exceeded.body.code).toBe("rate_limited");
    expect(exceeded.headers["retry-after"]).toBeDefined();
    expect(exceeded.body.type).toBe("https://form.example/errors/rate_limited");
  });

  it("spoofed X-Forwarded-For cannot mint fresh rate-limit buckets (trusted peer only)", async () => {
    const user = await newWorkspaceUser("session-spoof");
    const form = await publishForm(user.cookie);

    fx.rateLimiter.reset();
    // 30 attempts, each with a DIFFERENT spoofed X-Forwarded-For — with 0
    // trusted proxies every one lands in the same 127.0.0.1 bucket.
    for (let i = 0; i < 30; i += 1) {
      const res = await createSession(form.slug, {
        headers: { "X-Forwarded-For": `10.0.${Math.floor(i / 256)}.${i % 256}` },
      });
      expect(res.status).toBe(200);
    }
    // An unspoofed request shares the peer bucket and is rejected too.
    const plain = await createSession(form.slug);
    expect(plain.status).toBe(429);
  });

  it("stores the same IP HMAC for sessions from the same address (and different per form)", async () => {
    const user = await newWorkspaceUser("session-ip");
    const formA = await publishForm(user.cookie, {
      ...publishableEnvelope(),
      title: "Form A",
    } as FormSchema);
    const formB = await publishForm(user.cookie, {
      ...publishableEnvelope(),
      title: "Form B",
    } as FormSchema);

    fx.rateLimiter.reset();
    const a = await createSession(formA.slug);
    const b = await createSession(formB.slug);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const hashes = await admin.query<{ ip_hash: string }>(
      `SELECT ip_hash FROM app.form_sessions
        WHERE token_hash = ANY($1::text[])`,
      [
        [a.body.token as string, b.body.token as string].map((t) =>
          createHash("sha256").update(t).digest("hex"),
        ),
      ],
    );
    expect(hashes.rows).toHaveLength(2);
    // Same address → the same keyed HMAC on both rows.
    expect(hashes.rows[0]!.ip_hash).toBe(hashes.rows[1]!.ip_hash);
  });
});

describe("purge_expired_sessions (worker_user seam)", () => {
  it("purges sessions expired beyond 7 days as worker_user; direct SELECT is denied", async () => {
    const user = await newWorkspaceUser("session-purge");
    const form = await publishForm(user.cookie);

    fx.rateLimiter.reset();
    const keep = await createSession(form.slug);
    const stale = await createSession(form.slug);
    expect(keep.status).toBe(200);
    expect(stale.status).toBe(200);
    const staleHash = createHash("sha256").update(stale.body.token as string).digest("hex");

    // Expire the stale session beyond the 7-day purge horizon.
    await admin.query(
      `UPDATE app.form_sessions SET expires_at = now() - interval '8 days'
        WHERE token_hash = $1`,
      [staleHash],
    );

    const workerPool = new Pool({ connectionString: fx.urls.workerUrl, max: 1 });
    try {
      // Direct access is DENIED (42501) — the function is the only path.
      await expect(
        workerPool.query(`SELECT count(*)::int FROM app.form_sessions`),
      ).rejects.toMatchObject({ code: "42501" });

      const deleted = await purgeExpiredSessionsOnce({ databaseUrl: fx.urls.workerUrl });
      expect(deleted).toBeGreaterThanOrEqual(1);

      const staleRows = await admin.query(
        `SELECT 1 FROM app.form_sessions WHERE token_hash = $1`,
        [staleHash],
      );
      expect(staleRows.rows).toHaveLength(0);
      const keepRows = await admin.query(
        `SELECT 1 FROM app.form_sessions WHERE token_hash = $1`,
        [createHash("sha256").update(keep.body.token as string).digest("hex")],
      );
      expect(keepRows.rows).toHaveLength(1); // fresh sessions survive
    } finally {
      await workerPool.end();
    }
  });
});
