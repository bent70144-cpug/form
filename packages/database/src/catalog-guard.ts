/**
 * Catalog guard (ticket 05, spec: "The catalog guard test fails if any `app`
 * table with `workspace_id` lacks forced RLS, a policy with both `USING` and
 * `WITH CHECK`, or a composite tenant foreign key; it special-cases
 * `workspaces` by `id`").
 *
 * Read-only inspection of pg_catalog — works under any role:
 * 1. every `app`-schema table carrying a `workspace_id` column (plus the
 *    special-cased `workspaces`, keyed by `id`; `outbox_events` is
 *    intentionally exempt — it is not a tenant table — as is the
 *    `app.migrations` bookkeeping table) must have
 *    `relrowsecurity AND relforcerowsecurity`;
 * 2. at least one policy per such table must carry BOTH a USING qual and a
 *    WITH CHECK qual in `pg_policies` (USING alone is insufficient — an
 *    UPDATE could move a row to another workspace);
 * 3. every tenant foreign key on such a table must either be the root link
 *    (`(workspace_id) -> workspaces(id)`) or reference a parent-side UNIQUE
 *    `(workspace_id, id)` composite — this is what makes cross-tenant
 *    pinning impossible for forms/sessions/submissions.
 */

export type CatalogCheck = "forced_rls" | "policy_clauses" | "composite_fk";

export interface CatalogViolation {
  table: string;
  check: CatalogCheck;
  detail: string;
}

export class CatalogGuardError extends Error {
  readonly violations: CatalogViolation[];

  constructor(violations: CatalogViolation[]) {
    super(
      "Catalog guard failed — the app schema violates the tenancy invariants:\n" +
        violations
          .map((v) => `  - [${v.check}] ${v.table}: ${v.detail}`)
          .join("\n"),
    );
    this.name = "CatalogGuardError";
    this.violations = violations;
  }
}

/** Minimal query surface (works with pg Client, Pool, or PoolClient). */
interface Queryable {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface CatalogTable {
  oid: string;
  tableName: string;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  hasWorkspaceId: boolean;
}

interface CatalogFk {
  constraintName: string;
  parentTable: string;
  fkColumns: string[];
  refColumns: string[];
}

/** Tables that are intentionally outside the tenant-invariant rules. */
const EXEMPT_TABLES = new Set(["outbox_events", "migrations"]);

async function tenantTables(db: Queryable): Promise<CatalogTable[]> {
  const res = await db.query<{
    oid: string;
    table_name: string;
    row_security: boolean;
    force_row_security: boolean;
    has_workspace_id: boolean;
  }>(
    `SELECT c.oid::text AS oid,
            c.relname AS table_name,
            c.relrowsecurity AS row_security,
            c.relforcerowsecurity AS force_row_security,
            EXISTS (
              SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid
                AND a.attname = 'workspace_id'
                AND NOT a.attisdropped
            ) AS has_workspace_id
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relkind = 'r'
        AND c.relname <> ALL ($1::text[])`,
    [[...EXEMPT_TABLES]],
  );
  return res.rows
    .map((r) => ({
      oid: r.oid,
      tableName: r.table_name,
      rowSecurity: r.row_security,
      forceRowSecurity: r.force_row_security,
      hasWorkspaceId: r.has_workspace_id,
    }))
    // Tenant set: any table with workspace_id, plus `workspaces` itself,
    // which is keyed by id (spec's special case).
    .filter((t) => t.hasWorkspaceId || t.tableName === "workspaces");
}

async function hasBothClausePolicy(
  db: Queryable,
  tableName: string,
): Promise<boolean> {
  const res = await db.query<{ qual: string | null; with_check: string | null }>(
    `SELECT qual, with_check
       FROM pg_policies
      WHERE schemaname = 'app' AND tablename = $1`,
    [tableName],
  );
  return res.rows.some(
    (r) =>
      r.qual !== null &&
      r.with_check !== null &&
      r.qual.trim().length > 0 &&
      r.with_check.trim().length > 0,
  );
}

async function foreignKeys(
  db: Queryable,
  tableOid: string,
): Promise<CatalogFk[]> {
  const res = await db.query<{
    constraint_name: string;
    parent_table: string;
    fk_columns: string[];
    ref_columns: string[];
  }>(
    `SELECT con.conname AS constraint_name,
            con.confrelid::regclass::text AS parent_table,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a
                 ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            ) AS fk_columns,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a
                 ON a.attrelid = con.confrelid AND a.attnum = k.attnum
            ) AS ref_columns
       FROM pg_constraint con
      WHERE con.contype = 'f'
        AND con.conrelid = $1::oid`,
    [tableOid],
  );
  return res.rows.map((r) => ({
    constraintName: r.constraint_name,
    parentTable: r.parent_table,
    fkColumns: r.fk_columns ?? [],
    refColumns: r.ref_columns ?? [],
  }));
}

async function parentHasWorkspaceIdUnique(
  db: Queryable,
  parentOidOrName: string,
): Promise<boolean> {
  const res = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint pc
         JOIN pg_attribute a1
           ON a1.attrelid = pc.conrelid AND a1.attnum = pc.conkey[1]
         JOIN pg_attribute a2
           ON a2.attrelid = pc.conrelid AND a2.attnum = pc.conkey[2]
        WHERE pc.conrelid = $1::regclass
          AND pc.contype IN ('p', 'u')
          AND cardinality(pc.conkey) = 2
          AND a1.attname = 'workspace_id'
          AND a2.attname = 'id'
          AND NOT a1.attisdropped AND NOT a2.attisdropped
     ) AS ok`,
    [parentOidOrName],
  );
  return res.rows[0]!.ok;
}

/**
 * Returns every violation of the tenancy invariants (empty array = intact).
 */
export async function runCatalogGuard(
  db: Queryable,
): Promise<CatalogViolation[]> {
  const violations: CatalogViolation[] = [];

  for (const table of await tenantTables(db)) {
    if (!(table.rowSecurity && table.forceRowSecurity)) {
      violations.push({
        table: `app.${table.tableName}`,
        check: "forced_rls",
        detail: `relrowsecurity=${table.rowSecurity}, relforcerowsecurity=${table.forceRowSecurity} — expected ENABLE + FORCE ROW LEVEL SECURITY`,
      });
    }

    if (!(await hasBothClausePolicy(db, table.tableName))) {
      violations.push({
        table: `app.${table.tableName}`,
        check: "policy_clauses",
        detail:
          "no policy carries both USING and WITH CHECK (USING alone lets an UPDATE move rows across workspaces)",
      });
    }

    for (const fk of await foreignKeys(db, table.oid)) {
      if (!fk.fkColumns.includes("workspace_id")) {
        continue; // not a tenant relationship (e.g. a future user FK)
      }
      if (fk.fkColumns.length === 1) {
        // Root link: workspace_id -> workspaces(id), the only exemption.
        if (
          fk.parentTable !== "app.workspaces" ||
          fk.refColumns.join(",") !== "id"
        ) {
          violations.push({
            table: `app.${table.tableName}`,
            check: "composite_fk",
            detail: `root link ${fk.constraintName} must be (workspace_id) -> workspaces(id); got (${fk.fkColumns.join(", ")}) -> ${fk.parentTable}(${fk.refColumns.join(", ")})`,
          });
        }
        continue;
      }
      // Composite tenant FK: parent must expose UNIQUE (workspace_id, id) —
      // the guard verifies an actual p/u constraint, not just the reference.
      const fkRefOk =
        fk.refColumns.join(",") === "workspace_id,id" &&
        (await parentHasWorkspaceIdUnique(db, fk.parentTable));
      if (!fkRefOk) {
        violations.push({
          table: `app.${table.tableName}`,
          check: "composite_fk",
          detail: `FK ${fk.constraintName} (${fk.fkColumns.join(", ")}) must reference a UNIQUE (workspace_id, id) composite on the parent; references ${fk.parentTable}(${fk.refColumns.join(", ")})`,
        });
      }
    }
  }

  return violations;
}

/** Throws {@link CatalogGuardError} when the catalog violates invariants. */
export async function assertCatalogIntact(db: Queryable): Promise<void> {
  const violations = await runCatalogGuard(db);
  if (violations.length > 0) {
    throw new CatalogGuardError(violations);
  }
}
