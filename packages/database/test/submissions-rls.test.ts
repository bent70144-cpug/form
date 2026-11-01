import { beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapPersonalWorkspace,
  connectAs,
  newId,
  withTenant,
  RUN,
} from "./helpers";

/**
 * Ticket 11 — the RLS SEAM for the submission tables (spec "Testing
 * Decisions" seam 3: "RLS is a database guarantee and cannot be proven
 * through an API that might accidentally use a privileged connection").
 *
 * The catalog guard already proves `app.submissions` (and every other tenant
 * table) carries forced RLS with BOTH policy clauses and composite tenant
 * FKs (catalog-guard.test.ts). These tests add the BEHAVIORAL half:
 * app_user's cross-workspace SELECT returns nothing, and the policy's
 * WITH CHECK clause rejects cross-tenant writes — with a seeded submission
 * reachable through the exact grants the runtime role has.
 */

let USER_A: string;
let USER_B: string;
let WS_A: string;
let WS_B: string;

interface Seeded {
  formId: string;
  versionId: string;
  sessionId: string;
  submissionId: string;
}

const SEED: Seeded = { formId: "", versionId: "", sessionId: "", submissionId: "" };

async function seedSubmission(): Promise<void> {
  await withTenant(USER_A, WS_A, async (tx) => {
    // Default project → form → pinned version → session → submission, all
    // through the request role inside one tenant transaction (exactly the
    // runtime path's grants).
    const project = await tx.query<{ id: string }>(
      `SELECT id::text FROM app.projects
        WHERE workspace_id = $1 AND is_default AND deleted_at IS NULL`,
      [WS_A],
    );
    const formId = newId();
    await tx.query(
      `INSERT INTO app.forms (id, workspace_id, project_id, name, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Seeded inbox form', 'published')`,
      [formId, WS_A, project.rows[0]!.id],
    );
    const versionId = newId();
    await tx.query(
      `INSERT INTO app.form_versions (id, workspace_id, form_id, version_number, "schema")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb)`,
      [versionId, WS_A, formId, JSON.stringify({ schemaVersion: 1 })],
    );
    await tx.query(
      `UPDATE app.forms SET published_version_id = $2::uuid
        WHERE workspace_id = $1::uuid AND id = $3::uuid`,
      [WS_A, versionId, formId],
    );
    const sessionId = newId();
    await tx.query(
      `INSERT INTO app.form_sessions
         (id, workspace_id, form_id, form_version_id, token_hash, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now() + interval '24 hours')`,
      [sessionId, WS_A, formId, versionId, `seeded-token-hash-${RUN}`],
    );
    const submissionId = newId();
    await tx.query(
      `INSERT INTO app.submissions
         (id, workspace_id, form_id, form_version_id, form_session_id, answers)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::jsonb)`,
      [submissionId, WS_A, formId, versionId, sessionId, JSON.stringify({ q1: "Ada" })],
    );
    SEED.formId = formId;
    SEED.versionId = versionId;
    SEED.sessionId = sessionId;
    SEED.submissionId = submissionId;
  });
}

beforeAll(async () => {
  USER_A = newId();
  USER_B = newId();
  WS_A = await bootstrapPersonalWorkspace(USER_A);
  WS_B = await bootstrapPersonalWorkspace(USER_B);
  await seedSubmission();
});

describe("app.submissions forced-RLS behavior", () => {
  it("app_user in workspace B sees ZERO of A's submissions; A sees its own", async () => {
    await withTenant(USER_B, WS_B, async (tx) => {
      const all = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.submissions",
      );
      expect(Number(all.rows[0]!.count)).toBe(0);
    });
    await withTenant(USER_A, WS_A, async (tx) => {
      const own = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app.submissions
          WHERE id = $1::uuid AND form_id = $2::uuid`,
        [SEED.submissionId, SEED.formId],
      );
      expect(Number(own.rows[0]!.count)).toBe(1);
    });
  });

  it("a query WITHOUT tenant context returns no rows (nullif, not an error)", async () => {
    const appUser = await connectAs("app_user");
    try {
      const res = await appUser.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app.submissions
          WHERE id = $1::uuid`,
        [SEED.submissionId],
      );
      expect(Number(res.rows[0]!.count)).toBe(0);
    } finally {
      await appUser.end();
    }
  });

  it("WITH CHECK rejects inserting a submission claiming another workspace", async () => {
    await withTenant(USER_A, WS_A, async (tx) => {
      // Even pointing at A's OWN form, a row stamped with B's workspace id
      // violates the policy's WITH CHECK (42501), not a FK error.
      await expect(
        tx.query(
          `INSERT INTO app.submissions
             (id, workspace_id, form_id, form_version_id, form_session_id, answers)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, '{}'::jsonb)`,
          [newId(), WS_B, SEED.formId, SEED.versionId, SEED.sessionId],
        ),
      ).rejects.toHaveProperty("code", "42501");
    });
  });

  it("an UPDATE moving a submission's workspace_id is rejected (42501)", async () => {
    await withTenant(USER_A, WS_A, async (tx) => {
      await expect(
        tx.query(
          `UPDATE app.submissions SET workspace_id = $1::uuid WHERE id = $2::uuid`,
          [WS_B, SEED.submissionId],
        ),
      ).rejects.toHaveProperty("code", "42501");
    });
  });

  it("cross-tenant writes are silently scoped to zero rows", async () => {
    await withTenant(USER_B, WS_B, async (tx) => {
      const res = await tx.query(
        `UPDATE app.submissions SET answers = '{"hijacked":true}' WHERE id = $1::uuid`,
        [SEED.submissionId],
      );
      expect(res.rowCount).toBe(0);
    });
    await withTenant(USER_A, WS_A, async (tx) => {
      const answers = await tx.query<{ answers: Record<string, string> }>(
        `SELECT answers FROM app.submissions WHERE id = $1::uuid`,
        [SEED.submissionId],
      );
      expect(answers.rows[0]!.answers).toEqual({ q1: "Ada" });
    });
  });

  it("the submissions policy carries BOTH clauses and the table is FORCE-protected", async () => {
    const migrator = await connectAs("migrator");
    try {
      const policy = await migrator.query<{
        qual: string | null;
        with_check: string | null;
        cmd: string;
      }>(
        `SELECT cmd, qual, with_check FROM pg_policies
          WHERE schemaname = 'app' AND tablename = 'submissions'`,
      );
      expect(policy.rows.length).toBeGreaterThanOrEqual(1);
      for (const row of policy.rows) {
        // Both clauses present and referencing the tenant key (non-trivial).
        expect(row.qual).toMatch(/workspace_id/);
        expect(row.with_check).toMatch(/workspace_id/);
      }
      const rel = await migrator.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = 'submissions'`,
      );
      expect(rel.rows[0]!.relrowsecurity).toBe(true);
      expect(rel.rows[0]!.relforcerowsecurity).toBe(true);
    } finally {
      await migrator.end();
    }
  });
});
