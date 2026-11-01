import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { BLOCK_ID_RE, emptyDraft, type FormSchema } from "@form/form-schema";
import type { FormDetail } from "@form/contracts";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 09 API slice — publish / unpublish, end-to-end over the real HTTP
 * stack (supertest against createApiApp, embedded Postgres, REAL roles):
 *
 *   POST /v1/forms/{id}/publish   ONE transaction per spec: lock the form row
 *                                 (SELECT … FOR UPDATE), re-run the FULL
 *                                 publish validation, allocate the next
 *                                 version number, insert the IMMUTABLE
 *                                 form_versions snapshot, flip the published
 *                                 pointer + status, register the public slug
 *                                 (first publish only) through the
 *                                 security-definer register_form_slug(),
 *                                 write `form.published` audit + outbox.
 *                                 Validation failures → 422 with stable codes
 *                                 and NOTHING persisted; an injected failure
 *                                 rolls everything back; concurrent publishes
 *                                 serialize on the form row.
 *   POST /v1/forms/{id}/unpublish status `closed` + `form.unpublished`
 *                                 audit + outbox.
 *
 * Cross-tenant isolation is RLS: workspace B's publish of A's form is a 404.
 */

const SCRATCH_DB = "t09_publish_api";
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

async function signUp(email: string, password = "correct-horse-12") {
  const res = await request(app)
    .post("/v1/auth/sign-up/email")
    .set("Origin", fx.appName)
    .send({ name: "Publish User", email, password, callbackURL: "/dashboard" });
  expect(res.status).toBe(200);
  return res;
}

async function signIn(email: string, password = "correct-horse-12"): Promise<string> {
  const res = await request(app)
    .post("/v1/auth/sign-in/email")
    .set("Origin", fx.appName)
    .send({ email, password });
  expect(res.status).toBe(200);
  return cookieHeaderOf(res.headers["set-cookie"]);
}

async function newVerifiedUser(prefix: string): Promise<{ email: string; cookie: string }> {
  userSeq += 1;
  const email = `${prefix}-${Date.now()}-${userSeq}@t09.example`;
  await signUp(email);
  const raw = await waitForMailTo(email);
  const url = new URL(extractVerificationUrl(raw));
  const verified = await request(app).get(`${url.pathname}${url.search}`);
  expect([200, 302]).toContain(verified.status);
  const cookie = await signIn(email);
  return { email, cookie };
}

async function newWorkspaceUser(
  prefix: string,
): Promise<{ email: string; cookie: string; workspaceId: string }> {
  const { email, cookie } = await newVerifiedUser(prefix);
  const res = await request(app)
    .post("/v1/workspaces/bootstrap")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(res.status).toBe(200);
  return { email, cookie, workspaceId: res.body.workspace.id as string };
}

function createForm(cookie: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post("/v1/forms")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send(body);
}

function saveDraft(cookie: string, formId: string, schema: FormSchema, draftVersion: number) {
  return request(app)
    .put(`/v1/forms/${formId}/draft`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send({ schema: schema as unknown, draftVersion });
}

function publish(cookie: string, formId: string, options: { origin?: string | null } = {}) {
  const req = request(app).post(`/v1/forms/${formId}/publish`).set("Cookie", cookie);
  if (options.origin !== null) req.set("Origin", options.origin ?? fx.appName);
  return req.send();
}

function unpublish(cookie: string, formId: string) {
  return request(app)
    .post(`/v1/forms/${formId}/unpublish`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
}

function getPublic(slug: string, options: { origin?: string | null } = {}) {
  const req = request(app).get(`/v1/public/forms/${slug}`);
  if (options.origin !== null) req.set("Origin", options.origin ?? fx.appName);
  return req;
}

function bid(n: number): string {
  const id = `b${String(n).padStart(11, "0")}`;
  expect(id).toMatch(BLOCK_ID_RE);
  return id;
}

/** A minimal publishable envelope: welcome → question → ending. */
function publishableEnvelope(overrides: Record<string, unknown> = {}): FormSchema {
  return {
    ...emptyDraft(),
    title: "Client intake",
    blocks: [
      { id: bid(1), kind: "welcome", title: "Welcome" },
      { id: bid(2), kind: "short_text", label: "Full name", required: false },
      { id: bid(3), kind: "ending", title: "Thanks!" },
    ],
    ...overrides,
  } as FormSchema;
}

/** Raw row counts for the atomicity assertions (admin = RLS-exempt). */
async function publishState(workspaceId: string, formId: string) {
  const versions = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.form_versions WHERE workspace_id = $1 AND form_id = $2`,
    [workspaceId, formId],
  );
  const slugs = await admin.query<{ n: string; slugs: string[]; current: string[] }>(
    `SELECT count(*)::text AS n,
            coalesce(array_agg(slug ORDER BY created_at) FILTER (WHERE true), '{}') AS slugs,
            coalesce(array_agg(slug) FILTER (WHERE is_current), '{}') AS current
       FROM app.form_slugs WHERE workspace_id = $1 AND form_id = $2`,
    [workspaceId, formId],
  );
  const form = await admin.query<{
    status: string;
    published_version_id: string | null;
  }>(
    `SELECT status::text, published_version_id::text FROM app.forms WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, formId],
  );
  const outbox = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.outbox_events
      WHERE event_type IN ('form.published', 'form.unpublished')
        AND payload->>'formId' = $1`,
    [formId],
  );
  return {
    versionCount: Number(versions.rows[0]!.n),
    slugCount: Number(slugs.rows[0]!.n),
    slugs: slugs.rows[0]!.slugs,
    currentSlugs: slugs.rows[0]!.current,
    status: form.rows[0]!.status,
    publishedVersionId: form.rows[0]!.published_version_id,
    publishEventCount: Number(outbox.rows[0]!.n),
  };
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;
  admin = fx.adminClient;
}, 120_000);

afterAll(async () => {
  await fx.close();
});

describe("POST /v1/forms/{id}/publish — round trip", () => {
  it("publishes version 1 with an immutable snapshot, a 10-char base62 slug and size numbers", async () => {
    const { cookie, workspaceId } = await newWorkspaceUser("pub-ok");
    const form = (await createForm(cookie, {})).body as FormDetail;

    const draft = publishableEnvelope();
    const saved = await saveDraft(cookie, form.id, draft, 0);
    expect(saved.status).toBe(200);

    const res = await publish(cookie, form.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
    expect(res.body.formId).toBe(form.id);
    expect(res.body.versionNumber).toBe(1);
    expect(res.body.slug).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(typeof res.body.publishedAt).toBe("string");
    expect(res.body.submissionCapBytes).toBe(100 * 1024);
    expect(res.body.worstCaseBytes).toBeGreaterThan(0);
    expect(res.body.worstCaseBytes).toBeLessThan(res.body.submissionCapBytes);

    // Snapshot equality: the published version IS the validated draft.
    const version = await admin.query<{ schema: unknown }>(
      `SELECT schema FROM app.form_versions WHERE workspace_id = $1 AND form_id = $2 AND version_number = 1`,
      [workspaceId, form.id],
    );
    expect(version.rows[0]!.schema).toEqual(draft);

    // Status flipped, pointer set, slug registered, event emitted.
    const state = await publishState(workspaceId, form.id);
    expect(state.status).toBe("published");
    expect(state.publishedVersionId).not.toBeNull();
    expect(state.versionCount).toBe(1);
    expect(state.slugCount).toBe(1);
    expect(state.currentSlugs).toEqual([res.body.slug]);
    expect(state.publishEventCount).toBe(1);

    // Public endpoint serves the snapshot right away.
    const pub = await getPublic(res.body.slug).expect(200);
    expect(pub.headers["cache-control"]).toBe("no-store");
    expect(pub.body.status).toBe("published");
    expect(pub.body.versionNumber).toBe(1);
    expect(pub.body.schema).toEqual(draft);
  });

  it("republishing creates version 2 and keeps version 1 immutable + the slug stable", async () => {
    const { cookie, workspaceId } = await newWorkspaceUser("pub-re");
    const form = (await createForm(cookie, {})).body as FormDetail;
    await saveDraft(cookie, form.id, publishableEnvelope(), 0);
    const first = await publish(cookie, form.id);
    expect(first.status).toBe(200);
    const slugV1: string = first.body.slug;

    // Edit the DRAFT after publish — the published page must not change.
    const edited = publishableEnvelope({
      title: "Client intake v2",
      blocks: [
        { id: bid(1), kind: "welcome", title: "Welcome" },
        { id: bid(2), kind: "short_text", label: "Full name", required: true },
        { id: bid(3), kind: "ending", title: "Thanks!" },
      ],
    });
    const saved = await saveDraft(cookie, form.id, edited, 1);
    expect(saved.status).toBe(200);

    // The public page still serves version 1 while the draft moved on.
    const stillV1 = await getPublic(slugV1).expect(200);
    expect(stillV1.body.versionNumber).toBe(1);
    expect(stillV1.body.schema.title).toBe("Client intake");

    const second = await publish(cookie, form.id);
    expect(second.status).toBe(200);
    expect(second.body.versionNumber).toBe(2);
    expect(second.body.slug).toBe(slugV1); // republish keeps the current slug

    // Version 1 is immutable — the exact pre-republish snapshot survives.
    const v1 = await admin.query<{ schema: { title: string } }>(
      `SELECT schema FROM app.form_versions WHERE workspace_id = $1 AND form_id = $2 AND version_number = 1`,
      [workspaceId, form.id],
    );
    expect(v1.rows[0]!.schema.title).toBe("Client intake");

    const pub = await getPublic(slugV1).expect(200);
    expect(pub.body.versionNumber).toBe(2);
    expect(pub.body.schema.title).toBe("Client intake v2");
    expect(pub.body.schema.blocks[1].required).toBe(true);
  });
});

describe("POST /v1/forms/{id}/publish — validation failures persist NOTHING", () => {
  const cases: Array<{ name: string; envelope: () => FormSchema; code: string }> = [
    {
      name: "no question block",
      envelope: () => ({
        ...emptyDraft(),
        title: "x",
        blocks: [
          { id: bid(1), kind: "welcome", title: "Welcome" },
          { id: bid(3), kind: "ending", title: "Thanks!" },
        ],
      }) as FormSchema,
      code: "no_question_blocks",
    },
    {
      name: "empty question label",
      envelope: () => ({
        ...emptyDraft(),
        title: "x",
        blocks: [{ id: bid(2), kind: "short_text", label: "   ", required: false }],
      }) as FormSchema,
      code: "empty_label",
    },
    {
      name: "welcome not first",
      envelope: () => ({
        ...emptyDraft(),
        title: "x",
        blocks: [
          { id: bid(2), kind: "short_text", label: "Q", required: false },
          { id: bid(1), kind: "welcome", title: "Welcome" },
        ],
      }) as FormSchema,
      code: "welcome_not_first",
    },
    {
      name: "ending not last",
      envelope: () => ({
        ...emptyDraft(),
        title: "x",
        blocks: [
          { id: bid(3), kind: "ending", title: "Thanks!" },
          { id: bid(2), kind: "short_text", label: "Q", required: false },
        ],
      }) as FormSchema,
      code: "ending_not_last",
    },
    {
      name: "duplicate block ids",
      envelope: () => ({
        ...emptyDraft(),
        title: "x",
        blocks: [
          { id: bid(2), kind: "short_text", label: "Q1", required: false },
          { id: bid(2), kind: "long_text", label: "Q2", required: false },
        ],
      }) as FormSchema,
      code: "duplicate_block_id",
    },
    {
      name: "empty welcome title",
      envelope: () => ({
        ...emptyDraft(),
        title: "x",
        blocks: [
          { id: bid(1), kind: "welcome", title: "  " },
          { id: bid(2), kind: "short_text", label: "Q", required: false },
        ],
      }) as FormSchema,
      code: "empty_label",
    },
  ];

  for (const c of cases) {
    it(`422 ${c.code} for ${c.name} — no version, no slug, no event`, async () => {
      const { cookie, workspaceId } = await newWorkspaceUser("pub-bad");
      const form = (await createForm(cookie, {})).body as FormDetail;

      // Seed the invalid envelope DIRECTLY into the draft row: publish must
      // re-run the FULL validation over the stored draft no matter how it got
      // there (the draft-save endpoint would already reject some of these —
      // e.g. duplicate IDs — and publish is the last line of defense).
      await admin.query(
        `UPDATE app.form_drafts SET schema = $3::jsonb
          WHERE workspace_id = $1 AND form_id = $2`,
        [workspaceId, form.id, JSON.stringify(c.envelope())],
      );

      const res = await publish(cookie, form.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("validation_failed");
      const codes = (res.body.errors as Array<{ code: string }>).map((e) => e.code);
      expect(codes).toContain(c.code);

      const state = await publishState(workspaceId, form.id);
      expect(state.versionCount).toBe(0);
      expect(state.slugCount).toBe(0);
      expect(state.status).toBe("draft");
      expect(state.publishedVersionId).toBeNull();
      expect(state.publishEventCount).toBe(0);
    });
  }
});

describe("POST /v1/forms/{id}/publish — atomicity", () => {
  it("an injected version-insert failure rolls back version, pointer, status, slug, audit AND outbox", async () => {
    const { cookie, workspaceId } = await newWorkspaceUser("pub-atom");
    const form = (await createForm(cookie, {})).body as FormDetail;
    await saveDraft(cookie, form.id, publishableEnvelope(), 0);

    // Injection: a test-only trigger sabotages the version insert for THIS
    // form (marker title), simulating a crash mid-transaction.
    await admin.query(`
      CREATE OR REPLACE FUNCTION t09_inject_failure() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.schema->>'title' = 'INJECT_ROLLBACK' THEN
          RAISE EXCEPTION 'injected publish failure (test)';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await admin.query(`
      CREATE TRIGGER t09_inject_failure_trg
      BEFORE INSERT ON app.form_versions
      FOR EACH ROW EXECUTE FUNCTION t09_inject_failure()
    `);

    const boom = publishableEnvelope({ title: "INJECT_ROLLBACK" });
    await saveDraft(cookie, form.id, boom, 1); // draft_version is 1 after the save above
    const res = await publish(cookie, form.id);
    expect(res.status).toBeGreaterThanOrEqual(500);

    let state = await publishState(workspaceId, form.id);
    expect(state.versionCount).toBe(0);
    expect(state.slugCount).toBe(0);
    expect(state.status).toBe("draft");
    expect(state.publishedVersionId).toBeNull();
    expect(state.publishEventCount).toBe(0);

    // The same form publishes cleanly once the injection is gone.
    await admin.query(`DROP TRIGGER t09_inject_failure_trg ON app.form_versions`);
    await admin.query(`DROP FUNCTION t09_inject_failure()`);
    const retry = await publish(cookie, form.id);
    expect(retry.status).toBe(200);
    expect(retry.body.versionNumber).toBe(1);

    state = await publishState(workspaceId, form.id);
    expect(state.versionCount).toBe(1);
    expect(state.slugCount).toBe(1);
    expect(state.status).toBe("published");
    expect(state.publishEventCount).toBe(1);
  });
});

describe("POST /v1/forms/{id}/publish — concurrency", () => {
  it("two simultaneous publishes serialize on the form row: versions 1 and 2, no duplicates", async () => {
    const { cookie, workspaceId } = await newWorkspaceUser("pub-race");
    const form = (await createForm(cookie, {})).body as FormDetail;
    await saveDraft(cookie, form.id, publishableEnvelope(), 0);

    // Two REAL concurrent requests — separate pooled connections, both
    // racing the same form row's FOR UPDATE lock.
    const [a, b] = await Promise.all([
      publish(cookie, form.id),
      publish(cookie, form.id),
    ]);
    expect([a.status, b.status]).toEqual(expect.arrayContaining([200, 200]));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const numbers = [a.body.versionNumber, b.body.versionNumber].sort();
    expect(numbers).toEqual([1, 2]);
    expect(a.body.slug).toBe(b.body.slug); // first publish allocates; the other keeps it

    const state = await publishState(workspaceId, form.id);
    expect(state.versionCount).toBe(2);
    expect(state.slugCount).toBe(1);
  });
});

describe("publish — auth, origin and cross-tenant boundaries", () => {
  it("cross-tenant: workspace B cannot publish A's form (404) and cannot unpublish it either", async () => {
    const a = await newWorkspaceUser("pub-ten-a");
    const b = await newWorkspaceUser("pub-ten-b");
    const form = (await createForm(a.cookie, {})).body as FormDetail;
    await saveDraft(a.cookie, form.id, publishableEnvelope(), 0);

    const res = await publish(b.cookie, form.id);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
    const un = await unpublish(b.cookie, form.id);
    expect(un.status).toBe(404);

    const state = await publishState(a.workspaceId, form.id);
    expect(state.status).toBe("draft");
  });

  it("requires a session (401) and a same-origin Origin header (403)", async () => {
    const { cookie } = await newWorkspaceUser("pub-auth");
    const form = (await createForm(cookie, {})).body as FormDetail;

    const noCookie = await publish("", form.id);
    expect(noCookie.status).toBe(401);

    const noOrigin = await publish(cookie, form.id, { origin: null });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.code).toBe("origin_mismatch");

    const badOrigin = await publish(cookie, form.id, { origin: "https://evil.example" });
    expect(badOrigin.status).toBe(403);
  });

  it("404s a non-UUID formId instead of casting it", async () => {
    const { cookie } = await newWorkspaceUser("pub-uuid");
    const res = await publish(cookie, "not-a-uuid");
    expect(res.status).toBe(404);
  });
});

describe("unpublish and closed lifecycle", () => {
  it("unpublish → closed (public shows the closed message); republish reopens with a new version", async () => {
    const { cookie, workspaceId } = await newWorkspaceUser("pub-cycle");
    const form = (await createForm(cookie, {})).body as FormDetail;
    await saveDraft(cookie, form.id, publishableEnvelope(), 0);
    const first = await publish(cookie, form.id);
    expect(first.status).toBe(200);
    const slug: string = first.body.slug;

    const un = await unpublish(cookie, form.id);
    expect(un.status).toBe(200);
    expect(un.body).toEqual({ formId: form.id, status: "closed" });

    // Public reads closed (200), never 404.
    const closed = await getPublic(slug).expect(200);
    expect(closed.headers["cache-control"]).toBe("no-store");
    expect(closed.body).toEqual({ status: "closed" });

    const state = await publishState(workspaceId, form.id);
    expect(state.status).toBe("closed");
    expect(state.publishEventCount).toBe(2); // published + unpublished

    // Republish reopens: new immutable version, same slug, public again.
    const again = await publish(cookie, form.id);
    expect(again.status).toBe(200);
    expect(again.body.versionNumber).toBe(2);
    expect(again.body.slug).toBe(slug);
    const republished = await getPublic(slug).expect(200);
    expect(republished.body.status).toBe("published");
    expect(republished.body.versionNumber).toBe(2);
  });
});

describe("slug registry through the API seam", () => {
  it("old slugs redirect: renaming via register_form_slug makes the API return 308 to the canonical slug", async () => {
    const { cookie, workspaceId } = await newWorkspaceUser("pub-slug");
    const form = (await createForm(cookie, {})).body as FormDetail;
    await saveDraft(cookie, form.id, publishableEnvelope(), 0);
    const first = await publish(cookie, form.id);
    const oldSlug: string = first.body.slug;

    // M0 has NO rename UI — the rename seam is the registry function itself,
    // called directly (as the DB tests do) with the workspace context set.
    const newSlug = "R3n4medSl0";
    await admin.query(`SELECT set_config('app.workspace_id', $1, false)`, [workspaceId]);
    await admin.query(`SELECT app.register_form_slug($1::uuid, $2)`, [form.id, newSlug]);

    // Old slug → 308 permanent redirect to the canonical public path.
    const redirect = await getPublic(oldSlug);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.location).toBe(`/f/${newSlug}`);
    expect(redirect.headers["cache-control"]).toBe("no-store");

    // The canonical slug serves the snapshot.
    const canonical = await getPublic(newSlug).expect(200);
    expect(canonical.body.status).toBe("published");
    expect(canonical.body.versionNumber).toBe(1);

    // Republish after the rename: the CURRENT (renamed) slug is kept.
    const second = await publish(cookie, form.id);
    expect(second.status).toBe(200);
    expect(second.body.slug).toBe(newSlug);
    const stillRedirect = await getPublic(oldSlug);
    expect(stillRedirect.status).toBe(308);
  });

  it("never allocates a reserved word or a malformed slug", async () => {
    const { cookie } = await newWorkspaceUser("pub-slugfmt");
    const form = (await createForm(cookie, {})).body as FormDetail;
    await saveDraft(cookie, form.id, publishableEnvelope(), 0);
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post(`/v1/forms/${form.id}/unpublish`)
        .set("Origin", fx.appName)
        .set("Cookie", cookie)
        .send();
      expect(res.status).toBe(200);
      const republished = await publish(cookie, form.id);
      expect(republished.status).toBe(200);
      expect(republished.body.slug).toMatch(/^[A-Za-z0-9]{10}$/);
      expect(republished.body.slug).not.toMatch(
        /^(admin|api|app|auth|dashboard|f|health|login|logout|openapi|public|settings|signup|signin|static|v1|www)$/i,
      );
    }
  });
});
