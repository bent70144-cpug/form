import { Pool } from "pg";

/**
 * Database reachability probe for `/v1/health` (spec: health reports
 * "database reachability"). Uses the pooled app_user URL; a `SELECT 1` is
 * tenant-free, so the tenant-transaction guard is not needed here.
 */
export function createDatabaseCheck(databaseUrl: string): () => Promise<boolean> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  return async () => {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  };
}
