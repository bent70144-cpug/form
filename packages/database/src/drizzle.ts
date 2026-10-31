import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { FormDrizzle } from "./tenant";
import * as schema from "./schema";

/**
 * Pool-level Drizzle instance for NON-tenant queries only (health probes,
 * outbox maintenance). Tenant queries must go through `withTenantTransaction`,
 * whose `TenantDb.drizzle` is bound to the transaction client — the pool guard
 * rejects tenant-table statements outside a tenant transaction.
 */
export function createDrizzle(pool: Pool): FormDrizzle {
  return drizzle(pool, { schema: schema as never }) as unknown as FormDrizzle;
}

export { schema };
