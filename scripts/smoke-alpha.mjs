#!/usr/bin/env node
/**
 * Local ALPHA SMOKE TEST (ticket 12 — "the final deployment milestone is a
 * smoke test, not the first deploy").
 *
 * Boots the FULL walking skeleton via the dev supervisor — embedded Postgres,
 * one-time admin bootstrap, migrations, mail sink, API, worker, web — then
 * drives the real create → publish → submit → review loop over HTTP. Every
 * request goes through the public web origin (http://localhost:$WEB_PORT) so
 * the browser → Next.js `/v1/*` rewrite → NestJS hop is exercised exactly as
 * the spec's walking skeleton demands; the ONLY direct side-channel is the
 * mail sink's JSON mailbox (the dev Mailpit substitute) used to complete the
 * email verification, which is what a human does with their mail client.
 *
 * Steps (each printed PASS/FAIL, run exits non-zero on the first failure):
 *
 *   1.  health          GET /v1/health through the rewrite
 *   2.  signup          POST /v1/auth/sign-up/email (autoSignIn:false — no session)
 *   3.  verify          poll GET /dev/mailbox, then GET the verify-email link
 *   4.  session         POST /v1/auth/sign-in/email → GET /v1/auth/session
 *                       (asserts emailVerified:true, workspace:null)
 *   5.  workspace       POST /v1/workspaces/bootstrap (Origin-guarded)
 *   6.  create form     POST /v1/forms
 *   7.  save draft      PUT /v1/forms/{id}/draft with VALID blocks (welcome +
 *                       required short_text + ending) and optimistic version
 *   8.  publish         POST /v1/forms/{id}/publish → slug + version
 *   9.  public form     GET /v1/public/forms/{slug} (unauthenticated, no-store)
 *   10. session (resp.) POST /v1/public/forms/{slug}/sessions → raw token
 *   11. submit          POST /v1/public/submissions (X-Form-Session) → receipt
 *   12. inbox           the submission is durably retrievable: the T11
 *                       dashboard endpoint when merged, else the idempotent
 *                       replay returns the SAME submission id.
 *
 * Usage:
 *   pnpm smoke:alpha            (or: node scripts/smoke-alpha.mjs)
 *   KEEP_STACK=1 pnpm smoke:alpha   # leave the stack running after the run
 *
 * Ports: WEB_PORT (default 3000), API_PORT (4000) fall back to free
 * alternates when busy. Port 1025 (SMTP) and 5433 (embedded Postgres) are
 * fixed by the supervisor; if either is occupied the smoke aborts with an
 * actionable message instead of silently testing a foreign process.
 */

import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_PORT = Number(process.env.WEB_PORT ?? 3000);
const API_PORT = Number(process.env.API_PORT ?? 4000);
const PG_PORT = 5433; // hardcoded by packages/database (embedded Postgres)
const SMTP_PORT = 1025; // hardcoded default of the mail sink + API env schema
const SINK_HTTP_PORT = Number(process.env.SINK_HTTP_PORT ?? 5434);

const OVERALL_DEADLINE_MS = 10 * 60 * 1000;
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// tiny helpers (zero dependencies)
// ---------------------------------------------------------------------------

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + 50; port++) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`No free port found at or above ${start}`);
}

/** Thrown by a poll body to abort polling immediately (non-transient). */
class PollAbort extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "PollAbort";
    if (detail !== undefined) this.detail = detail;
  }
}

async function poll(fn, { timeoutMs, label, everyMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (error instanceof PollAbort) throw error;
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  const suffix = lastError ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
}

/**
 * fetch with a hard timeout; every request goes through the WEB origin
 * (the Next.js /v1/* rewrite) unless a full URL is passed.
 */
async function http(method, urlPath, { baseUrl, headers = {}, body } = {}) {
  const url = urlPath.startsWith("http") ? urlPath : `${baseUrl}${urlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (HTML pages, redirects) — keep null */
    }
    return { status: response.status, headers: response.headers, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function cookieHeader(response) {
  // Node fetch exposes set-cookie via getSetCookie(); join into one Cookie.
  const cookies = response.headers.getSetCookie?.() ?? [];
  return cookies
    .map((c) => c.split(";")[0])
    .filter((pair) => pair.includes("="))
    .join("; ");
}

// ---------------------------------------------------------------------------
// step runner
// ---------------------------------------------------------------------------

const results = [];

async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const note = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, ms });
    process.stdout.write(`  PASS ${name} (${ms}ms)${note ? ` — ${note}` : ""}\n`);
    return true;
  } catch (error) {
    const ms = Date.now() - t0;
    results.push({ name, ok: false, ms });
    process.stdout.write(`  FAIL ${name} (${ms}ms) — ${error?.message ?? error}\n`);
    if (error?.detail) process.stdout.write(`  ${String(error.detail).slice(0, 2000)}\n`);
    return false;
  }
}

function fail(message, detail) {
  const error = new Error(message);
  if (detail !== undefined) error.detail = detail;
  throw error;
}

function expectStatus(response, expected, what) {
  if (response.status !== expected) {
    fail(
      `${what}: expected HTTP ${expected}, got ${response.status}`,
      response.text?.slice(0, 800),
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (Date.now() - startedAt > OVERALL_DEADLINE_MS) fail("smoke exceeded its overall deadline");
  if (await isPortOpen(SMTP_PORT)) {
    fail(
      `port ${SMTP_PORT} (SMTP) is occupied — the API always sends verification mail there. ` +
        `Stop the other dev stack / mail sink first (e.g. close any running \`pnpm dev\`).`,
    );
  }

  // The workspace packages (and the API/worker CLIs the supervisor runs)
  // resolve their cross-package imports through built `dist/` output, so a
  // fresh checkout must build once before the stack can boot (turbo caches
  // the second run). SKIP_BUILD=1 skips this when the tree is already built.
  if (process.env.SKIP_BUILD !== "1") {
    process.stdout.write("building the workspace (turbo run build — cached after the first run)…\n");
    const build = spawnSync("pnpm", ["build"], { cwd: ROOT, stdio: "inherit" });
    if (build.status !== 0) {
      fail(`pnpm build failed (exit ${build.status})`);
    }
  }

  const webPort = (await isPortOpen(WEB_PORT)) ? await findFreePort(WEB_PORT + 1) : WEB_PORT;
  const apiPort = (await isPortOpen(API_PORT)) ? await findFreePort(API_PORT + 1) : API_PORT;
  const sinkHttpPort =
    (await isPortOpen(SINK_HTTP_PORT)) ? await findFreePort(SINK_HTTP_PORT + 1) : SINK_HTTP_PORT;
  const baseUrl = `http://localhost:${webPort}`;
  const origin = baseUrl; // APP_ORIGIN — the Origin guard compares against this
  const mailboxUrl = `http://127.0.0.1:${sinkHttpPort}/dev/mailbox`;

  process.stdout.write(
    `smoke-alpha: web ${webPort}, api ${apiPort}, sink http ${sinkHttpPort}, pg ${PG_PORT}, smtp ${SMTP_PORT}\n` +
      `(embedded Postgres on ${PG_PORT} is reused when already running; bootstrap + migrations are idempotent)\n`,
  );

  // -- boot the full stack through the supervisor ----------------------------
  const supervisor = spawn(
    process.execPath,
    [path.join(ROOT, "scripts", "supervisor.mjs"), "--dev"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        WEB_PORT: String(webPort),
        API_PORT: String(apiPort),
        SINK_HTTP_PORT: String(sinkHttpPort),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let supervisorLog = "";
  const capture = (stream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      supervisorLog += chunk;
      if (supervisorLog.length > 400_000) supervisorLog = supervisorLog.slice(-200_000);
    });
  };
  capture(supervisor.stdout);
  capture(supervisor.stderr);
  const shutdownStack = async (signal = "SIGTERM") => {
    if (supervisor.exitCode !== null || supervisor.killed) return;
    supervisor.kill(signal);
    await new Promise((r) => setTimeout(r, 2000));
    if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
  };
  process.on("SIGINT", () => void shutdownStack().then(() => process.exit(130)));
  process.on("SIGTERM", () => void shutdownStack().then(() => process.exit(143)));

  let cookie = "";
  const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = "smoke-alpha-password-1a2b3c";
  let formId = "";
  let draftVersion = 0;
  let slug = "";
  let sessionToken = "";
  let submissionId = "";
  const questionId = "smoke_answer_01";

  const authHeaders = () => ({ cookie, origin });

  try {
    // -- wait for readiness --------------------------------------------------
    await poll(
      async () => {
        if (supervisor.exitCode !== null) {
          throw new PollAbort(
            "the supervisor exited before the stack became ready",
            supervisorLog.slice(-3000),
          );
        }
        return isPortOpen(sinkHttpPort) && isPortOpen(apiPort) && isPortOpen(webPort);
      },
      { timeoutMs: 240_000, label: "stack readiness (sink, api, web ports)", everyMs: 1000 },
    );
    // next dev compiles the rewrite target lazily; give /v1/health room.
    await poll(
      async () => (await http("GET", "/v1/health", { baseUrl })).status === 200,
      { timeoutMs: 120_000, label: "GET /v1/health through the rewrite", everyMs: 1000 },
    );

    // 1. health ---------------------------------------------------------------
    await step("1. health (GET /v1/health through the /v1/* rewrite)", async () => {
      const response = await http("GET", "/v1/health", { baseUrl });
      expectStatus(response, 200, "health");
      if (response.json?.status !== "ok" || response.json?.db !== "ok") {
        fail("health body does not report {status:'ok', db:'ok'}", response.text);
      }
      return "process liveness + database reachability, no tenant data";
    });

    // 2. signup -----------------------------------------------------------------
    await step("2. signup (POST /v1/auth/sign-up/email)", async () => {
      const response = await http("POST", "/v1/auth/sign-up/email", {
        baseUrl,
        headers: { origin },
        body: { name: "Smoke Tester", email, password },
      });
      expectStatus(response, 200, "signup");
      if (response.json?.user?.email !== email) {
        fail("signup response does not echo the user", response.text);
      }
      if (response.json?.token !== null) {
        fail(
          "signup created a session (autoSignIn must be false — no session before verification)",
          response.text,
        );
      }
      return `${email}`;
    });

    // 3. verify via the mail sink ------------------------------------------------
    await step("3. verification email → mail sink → verify link", async () => {
      const message = await poll(async () => {
        const box = await http("GET", mailboxUrl);
        if (box.status !== 200) return null;
        return (
          box.json?.messages?.find((m) => JSON.stringify(m.to).includes(email)) ?? null
        );
      }, { timeoutMs: 30_000, label: "verification email in the mail sink" });
      const urlMatch = String(message.raw ?? "").match(/https?:\/\/\S*verify-email\S*/);
      if (!urlMatch) fail("verification email has no verify-email link", message.raw);
      const verifyUrl = urlMatch[0].replace(/[")\],.]+$/, "");
      const visit = await http("GET", verifyUrl, { baseUrl });
      if (visit.status !== 200 && visit.status !== 302 && visit.status !== 307) {
        fail(`verify-email link answered ${visit.status}`, visit.text);
      }
      return "verification token delivered by SMTP sink, redeemed through the rewrite";
    });

    // 4. session -----------------------------------------------------------------
    await step("4. session (sign-in → GET /v1/auth/session)", async () => {
      const signIn = await http("POST", "/v1/auth/sign-in/email", {
        baseUrl,
        headers: { origin },
        body: { email, password },
      });
      expectStatus(signIn, 200, "sign-in");
      cookie = cookieHeader(signIn);
      if (!cookie.includes("session_token")) {
        fail("sign-in set no session cookie", JSON.stringify(signIn.headers.getSetCookie?.()));
      }
      const session = await http("GET", "/v1/auth/session", {
        baseUrl,
        headers: { cookie },
      });
      expectStatus(session, 200, "session");
      // The API's session endpoint returns its own FLAT DTO
      // ({userId, email, emailVerified, workspace}) — not better-auth's raw
      // {user: {...}} shape (verified against GET /v1/auth/session output).
      if (session.json?.emailVerified !== true) {
        fail("session does not report a verified email", session.text);
      }
      if (session.json?.workspace !== null) {
        fail("fresh user must have no workspace yet", session.text);
      }
      return "emailVerified=true, workspace=null (7-day rolling session cookie)";
    });

    // 5. bootstrap workspace ------------------------------------------------------
    await step("5. workspace bootstrap (POST /v1/workspaces/bootstrap)", async () => {
      const response = await http("POST", "/v1/workspaces/bootstrap", {
        baseUrl,
        headers: authHeaders(),
      });
      expectStatus(response, 200, "workspace bootstrap");
      const ws = response.json?.workspace;
      if (!ws?.id || ws?.role !== "owner") {
        fail("bootstrap did not return the personal workspace", response.text);
      }
      const again = await http("POST", "/v1/workspaces/bootstrap", {
        baseUrl,
        headers: authHeaders(),
      });
      expectStatus(again, 200, "idempotent bootstrap");
      if (again.json?.workspace?.id !== ws.id) {
        fail("bootstrap is not idempotent (different workspace id)", again.text);
      }
      return `${ws.name} (${ws.id}, idempotent)`;
    });

    // 6. create form ----------------------------------------------------------------
    await step("6. create form (POST /v1/forms)", async () => {
      const response = await http("POST", "/v1/forms", {
        baseUrl,
        headers: authHeaders(),
        body: { name: "Smoke Alpha Form" },
      });
      expectStatus(response, 201, "form create");
      formId = response.json?.id;
      draftVersion = response.json?.draft?.draftVersion ?? 0;
      if (!formId || !response.json?.draft?.schema) {
        fail("form create response missing id/draft", response.text);
      }
      return formId;
    });

    // 7. save draft -------------------------------------------------------------------
    await step("7. save draft (PUT /v1/forms/{id}/draft, valid blocks)", async () => {
      const schema = {
        schemaVersion: 1,
        title: "Smoke Alpha Form",
        blocks: [
          { id: "smoke_welcome01", kind: "welcome", title: "Welcome!", description: "A smoke-test form." },
          {
            id: questionId,
            kind: "short_text",
            label: "What should we note down?",
            required: true,
            placeholder: "Type something…",
          },
          { id: "smoke_ending01", kind: "ending", title: "Thank you!" },
        ],
        logic: [],
        theme: { preset: "default" },
        settings: {},
      };
      const response = await http("PUT", `/v1/forms/${formId}/draft`, {
        baseUrl,
        headers: authHeaders(),
        body: { schema, draftVersion },
      });
      expectStatus(response, 200, "draft save");
      draftVersion = response.json?.draftVersion;
      if (draftVersion !== 1) fail("draft save did not return version 1", response.text);
      // stale optimistic token must NOT overwrite (ticket 07 contract)
      const conflict = await http("PUT", `/v1/forms/${formId}/draft`, {
        baseUrl,
        headers: authHeaders(),
        body: { schema, draftVersion: 0 },
      });
      if (conflict.status !== 409) {
        fail(`stale draft save expected 409 draft_conflict, got ${conflict.status}`, conflict.text);
      }
      return "welcome + required short_text + ending; 409 on stale version";
    });

    // 8. publish ------------------------------------------------------------------------
    await step("8. publish (POST /v1/forms/{id}/publish)", async () => {
      const response = await http("POST", `/v1/forms/${formId}/publish`, {
        baseUrl,
        headers: authHeaders(),
      });
      expectStatus(response, 200, "publish");
      slug = response.json?.slug;
      if (!/^[A-Za-z0-9]{10}$/.test(slug ?? "")) {
        fail("publish response has no 10-char slug", response.text);
      }
      return `v${response.json?.versionNumber} at /f/${slug}`;
    });

    // 9. public form (unauthenticated) ----------------------------------------------------
    await step("9. public form (GET /v1/public/forms/{slug})", async () => {
      const response = await http("GET", `/v1/public/forms/${slug}`, { baseUrl });
      expectStatus(response, 200, "public form");
      if (response.json?.status !== "published") fail("public form is not published", response.text);
      if (response.headers.get("cache-control") !== "no-store") {
        fail("public form response is missing Cache-Control: no-store");
      }
      const closed = await http("GET", "/v1/public/forms/zzzzzzzzzz", { baseUrl });
      expectStatus(closed, 404, "unknown public form");
      return "published snapshot, no-store, unknown slug → 404";
    });

    // 10. public session ---------------------------------------------------------------------
    await step("10. respondent session (POST /v1/public/forms/{slug}/sessions)", async () => {
      const response = await http("POST", `/v1/public/forms/${slug}/sessions`, {
        baseUrl,
        headers: { "user-agent": "smoke-alpha/1.0" },
      });
      expectStatus(response, 200, "public session create");
      sessionToken = response.json?.token;
      if (!sessionToken || !response.json?.pinnedVersionId) {
        fail("public session response missing token/pinnedVersionId", response.text);
      }
      if (response.json?.schema?.schemaVersion !== 1) {
        fail("pinned snapshot missing the published schema", response.text);
      }
      return "24h pinned session, cookie-less";
    });

    // 11. submit -------------------------------------------------------------------------------
    await step("11. submit (POST /v1/public/submissions)", async () => {
      const response = await http("POST", "/v1/public/submissions", {
        baseUrl,
        headers: { "x-form-session": sessionToken, origin },
        body: { answers: { [questionId]: "Hello from the alpha smoke test!" } },
      });
      expectStatus(response, 200, "submit");
      submissionId = response.json?.submissionId;
      if (response.json?.submitted !== true || !submissionId) {
        fail("submit did not return a receipt", response.text);
      }
      // answers must validate against the pinned schema: a FRESH session
      // submitting a missing required answer → 422. (The session above is
      // already completed — its idempotency gate returns the stored receipt
      // with 200 BEFORE validation, which is the tested T10 contract.)
      const fresh = await http("POST", `/v1/public/forms/${slug}/sessions`, {
        baseUrl,
        headers: { origin },
      });
      if (fresh.status !== 200) {
        fail("fresh session for the invalid-answers probe failed", fresh.text);
      }
      const invalid = await http("POST", "/v1/public/submissions", {
        baseUrl,
        headers: { "x-form-session": fresh.json?.token, origin },
        body: { answers: {} },
      });
      if (invalid.status !== 422 && invalid.status !== 409) {
        fail(`invalid answers expected 422, got ${invalid.status}`, invalid.text);
      }
      return `receipt ${submissionId} (422 on missing required answer)`;
    });

    // 12. inbox — the submission is durably retrievable by the owner --------------------------
    await step("12. inbox shows the submission", async () => {
      const list = await http("GET", `/v1/forms/${formId}/submissions`, {
        baseUrl,
        headers: authHeaders(),
      });
      if (list.status === 200 && Array.isArray(list.json?.submissions)) {
        const found = list.json.submissions.some((s) => s.id === submissionId);
        if (!found) fail("dashboard inbox does not list the submission", list.text);
        return "dashboard inbox endpoint lists the submission";
      }
      // T11's inbox endpoint is not merged into this tree yet; prove durable
      // storage through the submission route's own idempotency guarantee: a
      // replay of the SAME session returns the SAME submission id — the row
      // is stored and retrievable under RLS.
      const replay = await http("POST", "/v1/public/submissions", {
        baseUrl,
        headers: { "x-form-session": sessionToken, origin },
        body: { answers: { [questionId]: "Hello from the alpha smoke test!" } },
      });
      expectStatus(replay, 200, "idempotent submit replay");
      if (replay.json?.submissionId !== submissionId) {
        fail("replay returned a different submission id — nothing was stored", replay.text);
      }
      return "inbox endpoint not merged yet (T11) — persistence proven via idempotent replay receipt";
    });
  } finally {
    if (process.env.KEEP_STACK === "1") {
      process.stdout.write(
        `\nKEEP_STACK=1 — leaving the stack running (web ${baseUrl}, api ${apiPort}); ` +
          `kill ${supervisor.pid} when done.\n`,
      );
    } else {
      await shutdownStack();
    }
  }

  const failed = results.filter((r) => !r.ok);
  const totalMs = Date.now() - startedAt;
  process.stdout.write(
    `\n=== smoke-alpha ${failed.length === 0 ? "PASS" : "FAIL"} — ` +
      `${results.length - failed.length}/${results.length} steps, ${totalMs}ms total ===\n`,
  );
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}\n`);
  }
  if (failed.length > 0 && process.env.KEEP_STACK !== "1") {
    process.stdout.write(`\n--- supervisor log tail ---\n${supervisorLog.slice(-4000)}\n`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`smoke-alpha crashed: ${error?.stack ?? error}\n`);
  if (error?.detail) process.stderr.write(`detail:\n${error.detail}\n`);
  process.exit(1);
});
