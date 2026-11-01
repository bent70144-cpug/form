import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { HealthController, probeDatabase } from "../src/health.controller";

/**
 * Ticket 12 — the health endpoint reports PROCESS LIVENESS and DATABASE
 * REACHABILITY (spec: "A health endpoint reports process liveness and
 * database reachability without exposing tenant data"). These unit tests pin
 * the contract body `{status:"ok", db:boolean}` (packages/contracts
 * healthResponseSchema) and prove that a failing probe degrades to
 * `db:false` WITHOUT leaking error text (a pg error message can embed the
 * connection string — that is a secret, never a tenant-data channel).
 */

function fakePool(impl: (sql: string) => Promise<unknown>): Pool {
  return { query: impl } as unknown as Pool;
}

describe("probeDatabase", () => {
  it("runs exactly `SELECT 1` — no tenant tables, no parameters", async () => {
    const seen: string[] = [];
    const ok = await probeDatabase(async (sql) => {
      seen.push(sql);
      return { rows: [{ "?column?": 1 }] };
    });
    expect(ok).toBe(true);
    expect(seen).toEqual(["SELECT 1"]);
  });

  it("reports false when the probe fails", async () => {
    const ok = await probeDatabase(async () => {
      throw new Error("connection refused");
    });
    expect(ok).toBe(false);
  });

  it("reports false when the probe exceeds the timeout", async () => {
    const start = Date.now();
    const ok = await probeDatabase(() => new Promise(() => undefined), 25);
    expect(ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("a late failure of an already-lost race never becomes an unhandled rejection", async () => {
    // The timeout wins, then the query rejects afterwards — the probe must
    // have attached its own catch so Node's unhandledRejection stays quiet.
    const ok = await probeDatabase(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("late failure")), 60),
        ),
      25,
    );
    expect(ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});

describe("HealthController", () => {
  it("returns {status:'ok', db:true} on a reachable database", async () => {
    const controller = new HealthController(
      fakePool(async () => ({ rows: [{ "?column?": 1 }] })),
    );
    expect(await controller.health()).toEqual({ status: "ok", db: true });
  });

  it("returns {status:'ok', db:false} when the database is unreachable — and leaks nothing", async () => {
    const controller = new HealthController(
      fakePool(async () => {
        throw new Error(
          "password authentication failed for user app_user postgres://app_user:SECRETPW@db.example/db",
        );
      }),
    );
    const body = await controller.health();
    expect(body).toEqual({ status: "ok", db: false });
    // The error text (with the connection string) must not leak into the body.
    expect(JSON.stringify(body)).not.toContain("SECRETPW");
    expect(JSON.stringify(body)).not.toContain("db.example");
  });
});
