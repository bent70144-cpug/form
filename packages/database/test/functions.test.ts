import { beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapPersonalWorkspace,
  callFunction,
  connectAs,
  newId,
  randomSlug,
  TEST_SCHEMA,
  withTenant,
  withWorkspaceContext,
} from "./helpers";

/**
 * Security-definer function suite (tickets 05/06/09/10 DB slice):
 * get_published_form, resolve_public_form, register_form_slug,
 * resolve_form_session, purge_expired_sessions — every call exercised
 * through the real app_user / worker_user roles.
 */

let USER_A: string;
let USER_B: string;
let WS_A: string;
let WS_B: string;

interface Seed {
  formId: string;
  versionId: string;
  currentSlug: string;
  oldSlug: string | null;
  schema: unknown;
}

async function seedForm(
  userId: string,
  workspaceId: string,
  opts: {
    status?: "draft" | "published" | "closed";
    softDeleted?: boolean;
    withOldSlug?: boolean;
  } = {},
): Promise<Seed> {
  const status = opts.status ?? "published";
  const formId = newId();
  const draftId = newId();
  const versionId = newId();
  const currentSlug = randomSlug();
  const oldSlug = opts.withOldSlug ? randomSlug() : null;

  await withTenant(userId, workspaceId, async (tx) => {
    await tx.query(
      `INSERT INTO app.forms (id, workspace_id, project_id, name, status, created_by)
       SELECT $1::uuid, $2::uuid, p.id, 'Seeded Form', $3::app.form_status, $4::uuid
         FROM app.projects p
        WHERE p.workspace_id = $2::uuid AND p.is_default`,
      [formId, workspaceId, status, userId],
    );
    await tx.query(
      `INSERT INTO app.form_drafts (id, workspace_id, form_id, schema, last_edited_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::uuid)`,
      [draftId, workspaceId, formId, JSON.stringify(TEST_SCHEMA), userId],
    );
    await tx.query(
      "UPDATE app.forms SET current_draft_id = $1::uuid WHERE id = $2::uuid",
      [draftId, formId],
    );
    await tx.query(
      `INSERT INTO app.form_versions (id, workspace_id, form_id, version_number, schema, published_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::uuid)`,
      [versionId, workspaceId, formId, JSON.stringify(TEST_SCHEMA), userId],
    );
    await tx.query(
      `UPDATE app.forms
          SET status = $1::app.form_status,
              published_version_id = $2::uuid,
              deleted_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
        WHERE id = $4::uuid`,
      [status, versionId, opts.softDeleted ?? false, formId],
    );
    await tx.query(
      `INSERT INTO app.form_slugs (id, workspace_id, form_id, slug, is_current)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, true)`,
      [newId(), workspaceId, formId, currentSlug],
    );
    if (oldSlug !== null) {
      await tx.query(
        `INSERT INTO app.form_slugs (id, workspace_id, form_id, slug, is_current)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, false)`,
        [newId(), workspaceId, formId, oldSlug],
      );
    }
  });

  return { formId, versionId, currentSlug, oldSlug, schema: TEST_SCHEMA };
}

beforeAll(async () => {
  USER_A = newId();
  USER_B = newId();
  WS_A = await bootstrapPersonalWorkspace(USER_A);
  WS_B = await bootstrapPersonalWorkspace(USER_B);
});

describe("get_published_form", () => {
  it("returns the published snapshot with version metadata", async () => {
    const seed = await seedForm(USER_A, WS_A);
    const result = (await callFunction(
      "SELECT app.get_published_form($1) AS result",
      [seed.currentSlug],
    )) as Record<string, unknown>;

    expect(result.status).toBe("published");
    expect(result.formId).toBe(seed.formId);
    expect(result.workspaceId).toBe(WS_A);
    expect(result.versionNumber).toBe(1);
    expect(result.schema).toEqual(TEST_SCHEMA);
  });

  it("maps a closed form and a soft-deleted form to closed", async () => {
    const closed = await seedForm(USER_A, WS_A, { status: "closed" });
    const closedResult = (await callFunction(
      "SELECT app.get_published_form($1) AS result",
      [closed.currentSlug],
    )) as Record<string, unknown>;
    expect(closedResult.status).toBe("closed");

    const deleted = await seedForm(USER_A, WS_A, {
      status: "published",
      softDeleted: true,
    });
    const deletedResult = (await callFunction(
      "SELECT app.get_published_form($1) AS result",
      [deleted.currentSlug],
    )) as Record<string, unknown>;
    expect(deletedResult.status).toBe("closed");
  });

  it("never exposes drafts: a slug on an unpublished form reads closed, schema absent", async () => {
    const draft = await seedForm(USER_A, WS_A, { status: "draft" });
    const result = (await callFunction(
      "SELECT app.get_published_form($1) AS result",
      [draft.currentSlug],
    )) as Record<string, unknown>;
    expect(result.status).toBe("closed");
    expect(result.schema).toBeUndefined();
  });

  it("returns redirect + canonical slug for a superseded slug", async () => {
    const seed = await seedForm(USER_A, WS_A, { withOldSlug: true });
    expect(seed.oldSlug).not.toBeNull();

    const result = (await callFunction(
      "SELECT app.get_published_form($1) AS result",
      [seed.oldSlug],
    )) as Record<string, unknown>;
    expect(result.status).toBe("redirect");
    expect(result.canonicalSlug).toBe(seed.currentSlug);
  });

  it("returns not_found for an unknown slug", async () => {
    const result = (await callFunction(
      "SELECT app.get_published_form($1) AS result",
      [randomSlug()],
    )) as Record<string, unknown>;
    expect(result.status).toBe("not_found");
  });
});

describe("resolve_public_form", () => {
  it("returns ids, pinning metadata, and schema for the current published slug", async () => {
    const seed = await seedForm(USER_A, WS_A);
    const result = (await callFunction(
      "SELECT app.resolve_public_form($1) AS result",
      [seed.currentSlug],
    )) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.formId).toBe(seed.formId);
    expect(result.workspaceId).toBe(WS_A);
    expect(result.versionId).toBe(seed.versionId);
    expect(result.versionNumber).toBe(1);
    expect(result.slug).toBe(seed.currentSlug);
    expect(result.schema).toEqual(TEST_SCHEMA);
  });

  it("yields NULL for closed, superseded, or unknown slugs", async () => {
    const closed = await seedForm(USER_A, WS_A, { status: "closed" });
    const superseded = await seedForm(USER_A, WS_A, { withOldSlug: true });

    for (const slug of [
      closed.currentSlug,
      superseded.oldSlug as string,
      randomSlug(),
    ]) {
      const result = await callFunction(
        "SELECT app.resolve_public_form($1) AS result",
        [slug],
      );
      expect(result ?? null).toBeNull();
    }
  });
});

describe("register_form_slug", () => {
  it("rejects reserved route names", async () => {
    const seed = await seedForm(USER_A, WS_A);
    await withWorkspaceContext(USER_A, WS_A, async (client) => {
      await expect(
        client.query("SELECT app.register_form_slug($1::uuid, $2)", [
          seed.formId,
          "dashboard",
        ]),
      ).rejects.toThrow(/slug_reserved/);
    });
  });

  it("rejects slugs that are not 10 base62 characters", async () => {
    const seed = await seedForm(USER_A, WS_A);
    // One failing call per transaction: a RAISE aborts the surrounding txn.
    await withWorkspaceContext(USER_A, WS_A, async (client) => {
      await expect(
        client.query("SELECT app.register_form_slug($1::uuid, $2)", [
          seed.formId,
          "short",
        ]),
      ).rejects.toThrow(/slug_invalid_format/);
    });
    await withWorkspaceContext(USER_A, WS_A, async (client) => {
      await expect(
        client.query("SELECT app.register_form_slug($1::uuid, $2)", [
          seed.formId,
          "with-dash!!",
        ]),
      ).rejects.toThrow(/slug_invalid_format/);
    });
  });

  it("rejects forms outside the active workspace", async () => {
    const seedA = await seedForm(USER_A, WS_A);
    // B's context, A's form: not found — no tenant leakage, no enumeration.
    await withWorkspaceContext(USER_B, WS_B, async (client) => {
      await expect(
        client.query("SELECT app.register_form_slug($1::uuid, $2)", [
          seedA.formId,
          randomSlug(),
        ]),
      ).rejects.toThrow(/form_not_found/);
    });
  });

  it("registers the new slug and demotes the previous one to a redirect", async () => {
    const seed = await seedForm(USER_A, WS_A, { withOldSlug: true });
    const renamed = randomSlug();

    await withWorkspaceContext(USER_A, WS_A, async (client) => {
      await client.query("SELECT app.register_form_slug($1::uuid, $2)", [
        seed.formId,
        renamed,
      ]);
    });

    const nowCurrent = (await callFunction(
      "SELECT app.get_published_form($1) AS result",
      [renamed],
    )) as Record<string, unknown>;
    expect(nowCurrent.status).toBe("published");

    for (const old of [seed.currentSlug, seed.oldSlug as string]) {
      const redirect = (await callFunction(
        "SELECT app.get_published_form($1) AS result",
        [old],
      )) as Record<string, unknown>;
      expect(redirect.status).toBe("redirect");
      expect(redirect.canonicalSlug).toBe(renamed);
    }
  });

  it("raises the natural unique violation on a global slug collision", async () => {
    const seedA = await seedForm(USER_A, WS_A);
    const seedB = await seedForm(USER_B, WS_B);

    await withWorkspaceContext(USER_B, WS_B, async (client) => {
      await expect(
        client.query("SELECT app.register_form_slug($1::uuid, $2)", [
          seedB.formId,
          seedA.currentSlug, // already taken by workspace A's form
        ]),
      ).rejects.toHaveProperty("code", "23505");
    });
  });
});

describe("resolve_form_session", () => {
  const CASES = {
    usable: { hash: "", expiry: "now() + interval '1 hour'", completed: false },
    grace: { hash: "", expiry: "now() - interval '2 minutes'", completed: false },
    beyond: { hash: "", expiry: "now() - interval '6 minutes'", completed: false },
    completed: { hash: "", expiry: "now() + interval '1 hour'", completed: true },
  } as const;

  it("classifies usable / within-grace / beyond-grace / completed sessions", async () => {
    const seed = await seedForm(USER_A, WS_A);
    for (const c of Object.values(CASES)) {
      (c as { hash: string }).hash = `hash-${newId()}`;
    }

    await withTenant(USER_A, WS_A, async (tx) => {
      for (const [name, c] of Object.entries(CASES)) {
        await tx.query(
          `INSERT INTO app.form_sessions
             (id, workspace_id, form_id, form_version_id, token_hash, expires_at, completed_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, ${c.expiry},
                   CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
          [newId(), WS_A, seed.formId, seed.versionId, c.hash, c.completed],
        );
        void name;
      }
    });

    for (const [name, c] of Object.entries(CASES)) {
      const result = (await callFunction(
        "SELECT app.resolve_form_session($1) AS result",
        [c.hash],
      )) as Record<string, unknown>;
      expect(result, `session case ${name}`).not.toBeNull();
      const expected =
        name === "usable"
          ? "usable"
          : name === "grace"
            ? "within_grace"
            : name === "beyond"
              ? "expired_beyond_grace"
              : "usable";
      expect(result.state, `session case ${name}`).toBe(expected);
      expect(result.completed, `session case ${name}`).toBe(c.completed);
      expect(result.workspaceId).toBe(WS_A);
      expect(result.formId).toBe(seed.formId);
      expect(result.formVersionId).toBe(seed.versionId);
      expect(result.versionNumber).toBe(1);
      expect(result.formStatus).toBe("published");
      expect(result.formDeleted).toBe(false);
    }
  });

  it("resolves cross-tenant by token hash and returns NULL for unknown hashes", async () => {
    const seed = await seedForm(USER_A, WS_A);
    const hash = `hash-${newId()}`;
    await withTenant(USER_A, WS_A, async (tx) => {
      await tx.query(
        `INSERT INTO app.form_sessions
           (id, workspace_id, form_id, form_version_id, token_hash, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now() + interval '1 hour')`,
        [newId(), WS_A, seed.formId, seed.versionId, hash],
      );
    });
    // No app.workspace_id is set on this connection: the function resolves by
    // token hash alone and reports the workspace so the API can pin context.
    const result = (await callFunction(
      "SELECT app.resolve_form_session($1) AS result",
      [hash],
    )) as Record<string, unknown>;
    expect(result.workspaceId).toBe(WS_A);

    const unknown = await callFunction(
      "SELECT app.resolve_form_session($1) AS result",
      [`hash-${newId()}`],
    );
    expect(unknown ?? null).toBeNull();
  });
});

describe("security-definer function attributes", () => {
  /** aclitem[] has no built-in pg parser — normalize the string form. */
  function parsePgTextArray(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === "string") {
      return raw
        .replace(/^\{/, "")
        .replace(/\}$/, "")
        .split(",")
        .filter((entry) => entry.length > 0);
    }
    return [];
  }

  it("every function is owned by fn_owner, SECURITY DEFINER, pinned search_path", async () => {
    const migrator = await connectAs("migrator");
    try {
      const fns = await migrator.query<{
        proname: string;
        owner: string;
        prosecdef: boolean;
        search_path: string | null;
      }>(
        `SELECT p.proname,
                p.proowner::regrole::text AS owner,
                p.prosecdef,
                (SELECT option_value
                   FROM pg_options_to_table(p.proconfig)
                  WHERE option_name = 'search_path') AS search_path
           FROM pg_proc p
          WHERE p.pronamespace = 'app'::regnamespace
            AND p.proname IN ('list_workspaces', 'create_personal_workspace',
                              'get_published_form', 'resolve_public_form',
                              'register_form_slug', 'resolve_form_session',
                              'purge_expired_sessions')`,
      );
      expect(fns.rows).toHaveLength(7);
      for (const fn of fns.rows) {
        expect(fn.owner, `${fn.proname} owner`).toBe("fn_owner");
        expect(fn.prosecdef, `${fn.proname} security definer`).toBe(true);
        expect(fn.search_path, `${fn.proname} search_path`).toBe("app, pg_temp");
      }

      // fn_owner holds no schema-CREATE privilege outside the migration and
      // no BYPASSRLS; the NOLOGIN role exists only for these functions.
      const role = await migrator.query<{ rolbypassrls: boolean; rolcanlogin: boolean }>(
        `SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'fn_owner'`,
      );
      expect(role.rows[0]!.rolbypassrls).toBe(false);
      expect(role.rows[0]!.rolcanlogin).toBe(false);
    } finally {
      await migrator.end();
    }
  });

  it("execute is revoked from PUBLIC and granted to the caller roles only", async () => {
    const migrator = await connectAs("migrator");
    try {
      const acl = await migrator.query<{
        proname: string;
        acl: string[] | null;
      }>(
        `SELECT p.proname, p.proacl AS acl
           FROM pg_proc p
          WHERE p.pronamespace = 'app'::regnamespace
            AND p.proname IN ('purge_expired_sessions', 'create_personal_workspace')`,
      );
      const byName = new Map(
        acl.rows.map((r) => [r.proname, parsePgTextArray(r.acl)]),
      );
      const purgeAcl = byName.get("purge_expired_sessions") ?? [];
      expect(purgeAcl).toContain("worker_user=X/fn_owner");
      expect(purgeAcl.some((a) => a.includes("app_user"))).toBe(false);
      const bootstrapAcl = byName.get("create_personal_workspace") ?? [];
      expect(bootstrapAcl).toContain("app_user=X/fn_owner");
      expect(bootstrapAcl.some((a) => a.includes("worker_user"))).toBe(false);
      // No PUBLIC grant (empty grantee, e.g. "=X/fn_owner") remains.
      expect(purgeAcl.some((a) => a.startsWith("=X/"))).toBe(false);
      expect(bootstrapAcl.some((a) => a.startsWith("=X/"))).toBe(false);
    } finally {
      await migrator.end();
    }
  });
});

describe("purge_expired_sessions", () => {
  it("deletes sessions expired beyond 7 days across tenants; keeps fresh ones", async () => {
    const seed = await seedForm(USER_A, WS_A);
    const oldHash = `hash-old-${newId()}`;
    const freshHash = `hash-fresh-${newId()}`;

    await withTenant(USER_A, WS_A, async (tx) => {
      await tx.query(
        `INSERT INTO app.form_sessions
           (id, workspace_id, form_id, form_version_id, token_hash, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now() - interval '8 days')`,
        [newId(), WS_A, seed.formId, seed.versionId, oldHash],
      );
      await tx.query(
        `INSERT INTO app.form_sessions
           (id, workspace_id, form_id, form_version_id, token_hash, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now() + interval '1 hour')`,
        [newId(), WS_A, seed.formId, seed.versionId, freshHash],
      );
    });

    const worker = await connectAs("worker_user");
    try {
      const purged = await worker.query<{ purge: number }>(
        "SELECT app.purge_expired_sessions() AS purge",
      );
      expect(purged.rows[0]!.purge).toBeGreaterThanOrEqual(1);

      // worker_user's ONLY access to form_sessions is this function: direct
      // DML is revoked (42501), not merely filtered by RLS.
      await expect(
        worker.query("SELECT count(*) FROM app.form_sessions"),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        worker.query("DELETE FROM app.form_sessions WHERE 1 = 0"),
      ).rejects.toHaveProperty("code", "42501");
    } finally {
      await worker.end();
    }

    await withTenant(USER_A, WS_A, async (tx) => {
      const remaining = await tx.query<{ hash: string }>(
        "SELECT token_hash AS hash FROM app.form_sessions WHERE token_hash = ANY($1::text[])",
        [[oldHash, freshHash]],
      );
      expect(remaining.rows.map((r) => r.hash)).toEqual([freshHash]);
    });
  });
});
