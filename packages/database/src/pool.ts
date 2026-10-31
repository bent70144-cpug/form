import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { isTenantQuery } from "./tenant-tables";

/**
 * Pooled connection factory with the tenant-query guard.
 *
 * Spec: "A repository wrapper refuses tenant queries executed outside that
 * transaction." The guard intercepts every query on every pooled client and
 * rejects statements that reference a tenant table unless the client is inside
 * a `withTenantTransaction` block. Tenant repositories must therefore take the
 * wrapper's `TenantDb` handle — a plain pool query for tenant tables throws.
 */
export class TenantQueryOutsideTransactionError extends Error {
  constructor(sql: string) {
    super(
      `Refusing tenant query outside a tenant transaction (spec guardrail). Matched tenant table in: ${sql.slice(0, 200)}`,
    );
    this.name = "TenantQueryOutsideTransactionError";
  }
}

/** Clients currently inside a tenant transaction. */
const tenantTxClients = new WeakSet<object>();

export interface CreatePoolOptions {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Disable the guard for infrastructure connections (migrator runner). */
  tenantGuard?: boolean;
}

export function createPool(
  connectionString: string,
  options: CreatePoolOptions = {},
): Pool {
  const { tenantGuard = true, ...poolOptions } = options;
  const pool = new Pool({
    connectionString,
    max: poolOptions.max ?? 10,
    idleTimeoutMillis: poolOptions.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: poolOptions.connectionTimeoutMillis ?? 5_000,
  });
  if (tenantGuard) {
    pool.on("connect", (client) => installTenantGuard(client));
  }
  return pool;
}

/** Marks a client as being inside a tenant transaction. */
export function markTenantTransactionClient(client: PoolClient): void {
  tenantTxClients.add(client);
}

function installTenantGuard(client: PoolClient): void {
  const original = client.query.bind(client);
  const guarded = (...args: unknown[]) => {
    const first = args[0] as string | { text?: string } | undefined;
    const text =
      typeof first === "string" ? first : (first?.text as string | undefined);
    if (
      typeof text === "string" &&
      isTenantQuery(text) &&
      !tenantTxClients.has(client)
    ) {
      throw new TenantQueryOutsideTransactionError(text);
    }
    return (original as (...a: unknown[]) => Promise<QueryResult<QueryResultRow>>)(
      ...args,
    );
  };
  // pg's PoolClient.query is an overloaded method; the wrapper preserves the
  // call signature at runtime (strings, config objects, callbacks).
  (client as unknown as { query: unknown }).query = guarded;
}

export type { QueryResult, QueryResultRow };
