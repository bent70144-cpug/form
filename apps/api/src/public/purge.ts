import { Pool } from "pg";

/**
 * Worker-side purge job (ticket 10) — the exported CALL for the worker's
 * schedule registry. `purge_expired_sessions()` itself is the 0006 migration's
 * SECURITY DEFINER function owned by fn_owner and granted ONLY to worker_user
 * (the worker's single cross-tenant cleanup path — it can never SELECT
 * form_sessions directly).
 *
 * The dispatcher's schedule registry lives in packages/queue and the worker
 * handlers in apps/worker (queue-ticket ownership), so the schedule
 * REGISTRATION is a one-line wiring task for the owning ticket:
 *
 *   queue.schedule("purge-expired-sessions", { cron: "0 3 * * *" })  // daily
 *   queue.registerHandler("purge-expired-sessions", () =>
 *     purgeExpiredSessionsOnce({ databaseUrl: env.DATABASE_URL, logger }));
 *
 * This function is deliberately dependency-free (a short-lived pg Pool per
 * call) so either the API process or the worker process can drive it without
 * importing the queue package.
 */

export interface PurgeOptions {
  /** The POOLED WORKER user URL — the function is granted only to worker_user. */
  databaseUrl: string;
  logger?: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}

/** Calls app.purge_expired_sessions() once and returns the deleted-row count. */
export async function purgeExpiredSessionsOnce(options: PurgeOptions): Promise<number> {
  const pool = new Pool({ connectionString: options.databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ result: number }>(
      `SELECT app.purge_expired_sessions() AS result`,
    );
    const deleted = result.rows[0]?.result ?? 0;
    options.logger?.info({ deleted }, "purge_expired_sessions ran");
    return deleted;
  } finally {
    await pool.end();
  }
}
