import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { BLOCK_ID_RE, emptyDraft, type FormSchema } from "@form/form-schema";
import {
  draftSaveResponseSchema,
  type FormDetail,
} from "@form/contracts";
import { en } from "@form/i18n";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 07 API slice — draft save, end-to-end over the real HTTP stack
 * (supertest against createApiApp, embedded Postgres, REAL roles):
 *
 *   PUT /v1/forms/{id}/draft — replaces the FULL draft schema atomically with
 *   optimistic concurrency on `draftVersion` (mismatch → 409 `draft_conflict`,
 *   success increments and returns the new version). The envelope is migrated
 *   through the schemaVersion registry and validated by the SHARED
 *   @form/form-schema engine — every rejection carries the engine's stable
 *   code as a field error. The route's JSON body parser limit is explicitly
 *   configured at 300 KB (asserted at the boundary below), other routes keep
 *   their small explicit limits.
 */

const SCRATCH_DB = "t07_forms_draft_api";
let fx: AuthCoreFixture;
let app: Express;

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
    .send({ name: "Draft User", email, password, callbackURL: "/dashboard" });
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
  const email = `${prefix}-${Date.now()}-${userSeq}@t07.example`;
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

function getForm(cookie: string, formId: string) {
  return request(app).get(`/v1/forms/${formId}`).set("Cookie", cookie);
}

function saveDraft(cookie: string, formId: string, body: unknown) {
  return request(app)
    .put(`/v1/forms/${formId}/draft`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send(body as Record<string, unknown>);
}

/** Raw-body save (bypasses supertest's JSON serialization size checks). */
function saveDraftRaw(cookie: string, formId: string, rawJson: string) {
  return request(app)
    .put(`/v1/forms/${formId}/draft`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .set("Content-Type", "application/json")
    .send(rawJson);
}

/** A block id that always satisfies the server-side format rule. */
function bid(n: number): string {
  const id = `b${String(n).padStart(11, "0")}`;
  expect(id).toMatch(BLOCK_ID_RE);
  return id;
}

function envelope(overrides: Record<string, unknown> = {}): FormSchema {
  // Deliberately loose: several tests build INTENTIONALLY invalid envelopes
  // (unknown kinds/fields) that must reach the server and fail there.
  return { ...emptyDraft(), title: "Client intake", ...overrides } as FormSchema;
}

const shortTextBlock = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "short_text",
  label: "Full name",
  required: false,
  ...extra,
});

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;
}, 120_000);

afterAll(async () => {
  await fx.close();
});

describe("PUT /v1/forms/{id}/draft — valid saves", () => {
  it("round-trips a valid draft: replaces the schema, increments the version, persists", async () => {
    const { cookie } = await newWorkspaceUser("draft-ok");
    const form = (await createForm(cookie, {})).body as FormDetail;
    expect(form.draft.draftVersion).toBe(0);

    const schema = envelope({
      title: "Client intake (draft)",
      blocks: [
        {
          id: bid(1),
          kind: "welcome",
          title: "Welcome!",
          description: "A short intro",
        },
        shortTextBlock(bid(2), { label: "Full name", required: true, placeholder: "Jane Doe" }),
        {
          id: bid(3),
          kind: "long_text",
          label: "Project brief",
          required: false,
        },
        { id: bid(4), kind: "ending", title: "Thanks!" },
      ],
      logic: [],
    });

    const save1 = await saveDraft(cookie, form.id, {
      schema,
      draftVersion: 0,
    });
    expect(save1.status).toBe(200);
    expect(draftSaveResponseSchema.safeParse(save1.body).success).toBe(true);
    expect(save1.body).toEqual({ draftVersion: 1 });

    // Reload: the stored schema and version round-trip.
    const read1 = await getForm(cookie, form.id);
    expect(read1.status).toBe(200);
    expect((read1.body as FormDetail).draft.draftVersion).toBe(1);
    expect((read1.body as FormDetail).draft.schema).toEqual(schema);

    // Second save from the new last-seen version.
    const schema2 = { ...schema, title: "Client intake v2" };
    const save2 = await saveDraft(cookie, form.id, {
      schema: schema2,
      draftVersion: 1,
    });
    expect(save2.status).toBe(200);
    expect(save2.body).toEqual({ draftVersion: 2 });

    const stored = await fx.adminClient.query<{
      draft_version: number;
      schema: FormSchema;
      last_edited_by: string | null;
    }>(
      `SELECT draft_version, "schema", last_edited_by::text
         FROM app.form_drafts WHERE form_id = $1`,
      [form.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.draft_version).toBe(2);
    expect(stored.rows[0]!.schema).toEqual(schema2);
    expect(stored.rows[0]!.last_edited_by).toBeTruthy();
  });

  it("saves the empty envelope and incomplete blocks (drafts are lenient)", async () => {
    const { cookie } = await newWorkspaceUser("draft-empty");
    const form = (await createForm(cookie, {})).body as FormDetail;

    // The exact empty envelope is structurally valid.
    const empty = await saveDraft(cookie, form.id, {
      schema: emptyDraft(),
      draftVersion: 0,
    });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ draftVersion: 1 });

    // Empty labels, missing optionals, no question blocks: all fine at draft.
    const lenient = await saveDraft(cookie, form.id, {
      schema: envelope({
        title: "",
        blocks: [
          { id: bid(5), kind: "welcome", title: "" },
          { id: bid(6), kind: "short_text", label: "", required: false },
        ],
      }),
      draftVersion: 1,
    });
    expect(lenient.status).toBe(200);
    expect(lenient.body).toEqual({ draftVersion: 2 });
  });

  it("answers 404 for unknown ids, non-UUID path params and cross-workspace forms", async () => {
    const { cookie } = await newWorkspaceUser("draft-404");
    const foreign = (await createForm(cookie, {})).body as FormDetail;

    // Another workspace's form: 404, indistinguishable from missing.
    const { cookie: cookieB } = await newWorkspaceUser("draft-404-b");
    const hijack = await saveDraft(cookieB, foreign.id, {
      schema: envelope(),
      draftVersion: 0,
    });
    expect(hijack.status).toBe(404);
    expect(hijack.body.code).toBe("not_found");

    const unknown = await saveDraft(
      cookie,
      "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b",
      { schema: envelope(), draftVersion: 0 },
    );
    expect(unknown.status).toBe(404);
    const junk = await saveDraft(cookie, "not-a-uuid", {
      schema: envelope(),
      draftVersion: 0,
    });
    expect(junk.status).toBe(404);
    // Foreign form untouched.
    const read = await getForm(cookie, foreign.id);
    expect((read.body as FormDetail).draft.draftVersion).toBe(0);
  });
});

describe("PUT draft — schema validation failures (shared engine codes)", () => {
  it("rejects each failure class with 422 and the stable field code", async () => {
    const { cookie } = await newWorkspaceUser("draft-bad");
    const form = (await createForm(cookie, {})).body as FormDetail;

    const cases: Array<{
      name: string;
      schema: unknown;
      path: string;
      code: string;
    }> = [
      {
        name: "NUL in a block label",
        schema: envelope({
          blocks: [shortTextBlock(bid(1), { label: "Bad\u0000name" })],
        }),
        path: "blocks.0.label",
        code: "invalid_character",
      },
      {
        name: "NUL in the form title",
        schema: envelope({ title: "Bad\u0000title" }),
        path: "title",
        code: "invalid_character",
      },
      {
        name: "byte cap with a multibyte emoji payload",
        schema: envelope({ settings: { pad: "🎉".repeat(70_000) } }),
        path: "",
        code: "schema_too_large",
      },
      {
        name: "201 blocks",
        schema: envelope({
          blocks: Array.from({ length: 201 }, (_, i) => shortTextBlock(bid(i + 1))),
        }),
        path: "blocks",
        code: "too_many_blocks",
      },
      {
        name: "duplicate block IDs",
        schema: envelope({
          blocks: [shortTextBlock(bid(7)), shortTextBlock(bid(7))],
        }),
        path: "blocks.1.id",
        code: "duplicate_block_id",
      },
      {
        name: "bad block ID format",
        schema: envelope({ blocks: [shortTextBlock("short id!")] }),
        path: "blocks.0.id",
        code: "invalid_block_id",
      },
      {
        name: "unknown block kind",
        schema: envelope({
          blocks: [{ id: bid(8), kind: "rating", label: "Rate us", required: false }],
        }),
        path: "blocks.0.kind",
        code: "unsupported_block_kind",
      },
      {
        name: "unknown field on a block",
        schema: envelope({
          blocks: [shortTextBlock(bid(9), { foo: 1 })],
        }),
        path: "blocks.0.foo",
        code: "unknown_field",
      },
      {
        name: "unknown field on the envelope",
        schema: { ...envelope(), bonus: true },
        path: "bonus",
        code: "unknown_field",
      },
      {
        name: "form title over 200 characters",
        schema: envelope({ title: "x".repeat(201) }),
        path: "title",
        code: "title_too_long",
      },
    ];

    for (const c of cases) {
      const res = await saveDraft(cookie, form.id, {
        schema: c.schema,
        draftVersion: 0,
      });
      expect(res.status, c.name).toBe(422);
      expect(res.body.code, c.name).toBe("validation_failed");
      expect(res.headers["content-type"], c.name).toContain(
        "application/problem+json",
      );
      const errors = res.body.errors as Array<{
        path: string;
        code: string;
        message: string;
      }>;
      const match = errors.find((e) => e.code === c.code);
      expect(match, `${c.name} → ${c.code}`).toBeTruthy();
      // Field errors carry the engine's path (envelope-rooted) verbatim.
      expect(match!.path, c.name).toBe(c.path);
      // Human-readable messages come from the i18n catalog by stable key.
      expect(match!.message, c.name).toBe(
        en.errors.schemaIssues[c.code as keyof typeof en.errors.schemaIssues],
      );
    }
  });

  it("maps unsupported schemaVersions through migrateSchema explicitly", async () => {
    const { cookie } = await newWorkspaceUser("draft-migrate");
    const form = (await createForm(cookie, {})).body as FormDetail;

    for (const schemaVersion of [2, 0, "1"]) {
      const res = await saveDraft(cookie, form.id, {
        schema: { ...envelope(), schemaVersion },
        draftVersion: 0,
      });
      expect(res.status, String(schemaVersion)).toBe(422);
      expect(res.body.errors).toEqual([
        {
          path: "schema.schemaVersion",
          code: "unsupported_schema_version",
          message: en.errors.schemaIssues.unsupported_schema_version,
        },
      ]);
    }

    // Envelope WITHOUT a version can't be migrated either.
    const noVersion = envelope();
    delete (noVersion as Partial<FormSchema>).schemaVersion;
    const missing = await saveDraft(cookie, form.id, {
      schema: noVersion,
      draftVersion: 0,
    });
    expect(missing.status).toBe(422);
    expect(missing.body.errors[0].code).toBe("unsupported_schema_version");

    // Non-object schemas reach the engine and get the root type error.
    for (const schema of [[], "nope", null]) {
      const res = await saveDraft(cookie, form.id, { schema, draftVersion: 0 });
      expect(res.status, JSON.stringify(schema)).toBe(422);
      expect(res.body.errors[0].code).toBe("invalid_type");
    }
  });

  it("rejects malformed wrappers with 422 validation_failed (contract layer)", async () => {
    const { cookie } = await newWorkspaceUser("draft-wrap");
    const form = (await createForm(cookie, {})).body as FormDetail;

    const noVersion = await saveDraft(cookie, form.id, { schema: envelope() });
    expect(noVersion.status).toBe(422);
    expect(noVersion.body.code).toBe("validation_failed");

    const noSchema = await saveDraft(cookie, form.id, { draftVersion: 0 });
    expect(noSchema.status).toBe(422);

    const negative = await saveDraft(cookie, form.id, {
      schema: envelope(),
      draftVersion: -1,
    });
    expect(negative.status).toBe(422);

    const fractional = await saveDraft(cookie, form.id, {
      schema: envelope(),
      draftVersion: 1.5,
    });
    expect(fractional.status).toBe(422);

    const extra = await saveDraft(cookie, form.id, {
      schema: envelope(),
      draftVersion: 0,
      extra: true,
    });
    expect(extra.status).toBe(422);
  });

  it("leaves the stored draft untouched after a failed save", async () => {
    const { cookie } = await newWorkspaceUser("draft-keep");
    const form = (await createForm(cookie, {})).body as FormDetail;
    const good = envelope({ title: "Untouched" });
    const save = await saveDraft(cookie, form.id, {
      schema: good,
      draftVersion: 0,
    });
    expect(save.status).toBe(200);

    const bad = await saveDraft(cookie, form.id, {
      schema: envelope({
        title: "Untouched",
        blocks: [shortTextBlock(bid(1), { label: "NUL\u0000" })],
      }),
      draftVersion: 1,
    });
    expect(bad.status).toBe(422);

    const read = await getForm(cookie, form.id);
    expect((read.body as FormDetail).draft.draftVersion).toBe(1);
    expect((read.body as FormDetail).draft.schema).toEqual(good);
  });
});

describe("PUT draft — optimistic concurrency", () => {
  it("answers 409 draft_conflict on a stale draftVersion and never overwrites", async () => {
    const { cookie } = await newWorkspaceUser("draft-stale");
    const form = (await createForm(cookie, {})).body as FormDetail;
    const first = envelope({ title: "Saved v1" });
    const save = await saveDraft(cookie, form.id, {
      schema: first,
      draftVersion: 0,
    });
    expect(save.status).toBe(200);

    const stale = await saveDraft(cookie, form.id, {
      schema: envelope({ title: "Overwrite attempt" }),
      draftVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("draft_conflict");
    expect(stale.headers["content-type"]).toContain("application/problem+json");
    expect(stale.body.detail).toBe(en.errors.draftConflict.detail);
    expect(stale.body.status).toBe(409);

    // The stored draft is EXACTLY what the winning save wrote.
    const read = await getForm(cookie, form.id);
    expect((read.body as FormDetail).draft.draftVersion).toBe(1);
    expect((read.body as FormDetail).draft.schema).toEqual(first);
  });

  it("lets two tabs race with the same last-seen version: one 200, one 409", async () => {
    const { cookie } = await newWorkspaceUser("draft-race");
    const form = (await createForm(cookie, {})).body as FormDetail;

    // Both tabs loaded draft_version 0...
    const tabA = saveDraft(cookie, form.id, {
      schema: envelope({ title: "Tab A" }),
      draftVersion: 0,
    });
    const tabB = saveDraft(cookie, form.id, {
      schema: envelope({ title: "Tab B" }),
      draftVersion: 0,
    });
    const [resA, resB] = await Promise.all([tabA, tabB]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = resA.status === 409 ? resA : resB;
    const winner = resA.status === 200 ? resA : resB;
    expect(loser.body.code).toBe("draft_conflict");
    expect(winner.body).toEqual({ draftVersion: 1 });

    // Exactly the winner's schema is stored, version 1.
    const read = await getForm(cookie, form.id);
    const detail = read.body as FormDetail;
    expect(detail.draft.draftVersion).toBe(1);
    expect(detail.draft.schema.title).toBe(
      resA.status === 200 ? "Tab A" : "Tab B",
    );
  });
});

describe("PUT draft — explicit body-parser boundary (300 KB)", () => {
  it("rejects a ~301 KB body with 413 and lets a ~250 KB envelope reach validation", async () => {
    const { cookie } = await newWorkspaceUser("draft-limit");
    const form = (await createForm(cookie, {})).body as FormDetail;

    // OVER the configured 300 KB route limit → the parser rejects the request
    // with 413 BEFORE any validation (the adapter default of 100 KB would
    // also reject it, but 250 KB below would NOT pass — this boundary pins
    // the CONFIGURED value).
    const oversized = JSON.stringify({
      schema: envelope({ settings: { pad: "a".repeat(310_000) } }),
      draftVersion: 0,
    });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(300 * 1024);
    const tooBig = await saveDraftRaw(cookie, form.id, oversized);
    expect(tooBig.status).toBe(413);

    // ~238 KB of VALID envelope content: under the configured 300 KB parser
    // limit AND under the 256 KB schema byte cap → saves fine. This is what
    // distinguishes the configured 300 KB parser from the global 64 KB one.
    const bigSchema = envelope({
      blocks: Array.from({ length: 100 }, (_, i) =>
        shortTextBlock(bid(i + 1), {
          label: "a".repeat(500),
          description: "b".repeat(1800),
        }),
      ),
    });
    const bigBody = JSON.stringify({ schema: bigSchema, draftVersion: 0 });
    const bytes = Buffer.byteLength(bigBody, "utf8");
    expect(bytes).toBeGreaterThan(64 * 1024); // global limit would 413
    expect(bytes).toBeLessThan(256 * 1024); // schema byte cap still honored
    expect(bytes).toBeLessThan(300 * 1024); // under the configured parser limit

    const saved = await saveDraftRaw(cookie, form.id, bigBody);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ draftVersion: 1 });
  });

  it("keeps the small explicit limit for other routes (64 KB global)", async () => {
    const { cookie } = await newWorkspaceUser("draft-global");
    const form = (await createForm(cookie, {})).body as FormDetail;

    const hugeName = JSON.stringify({ name: "x".repeat(70_000) });
    const res = await request(app)
      .patch(`/v1/forms/${form.id}`)
      .set("Origin", fx.appName)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send(hugeName);
    expect(res.status).toBe(413);
  });
});

describe("PUT draft — auth and origin", () => {
  it("requires a verified session and the same-origin header", async () => {
    // Unverified: signed up, never verified.
    userSeq += 1;
    const email = `draft-unv-${Date.now()}-${userSeq}@t07.example`;
    await signUp(email);
    const unverified = await signIn(email);
    const resUnverified = await saveDraft(unverified, "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b", {
      schema: envelope(),
      draftVersion: 0,
    });
    expect(resUnverified.status).toBe(403);
    expect(resUnverified.body.code).toBe("email_unverified");

    const { cookie } = await newWorkspaceUser("draft-origin");
    const form = (await createForm(cookie, {})).body as FormDetail;
    const noOrigin = await request(app)
      .put(`/v1/forms/${form.id}/draft`)
      .set("Cookie", cookie)
      .send({ schema: envelope(), draftVersion: 0 });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.code).toBe("origin_mismatch");
  });
});
