import type { Client } from "pg";

/** The non-public Postgres schema Better Auth lives in (spec decision). */
export const AUTH_SCHEMA = "auth";

/** Schema/table ownership probe used by the spike test and the ADR. */
export async function getAuthTablesDdlOwner(admin: Client): Promise<string[]> {
  const res = await admin.query<{ table_owner: string }>(
    `SELECT DISTINCT table_owner FROM information_schema.tables WHERE table_schema = $1`,
    [AUTH_SCHEMA],
  );
  return res.rows.map((r) => r.table_owner);
}
