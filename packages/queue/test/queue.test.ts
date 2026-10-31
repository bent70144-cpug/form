import { describe, expect, it } from "vitest";
import { createInMemoryQueue } from "../src/index";
import { PgBossJobQueue } from "../src/adapters/pgboss";

describe("queue port", () => {
  it("in-memory adapter dispatches registered handlers", async () => {
    const queue = createInMemoryQueue();
    const seen: string[] = [];
    queue.registerHandler<{ id: string }>("ping", (payload) => {
      seen.push(payload.id);
    });
    const { id } = await queue.enqueue("ping", { id: "p1" });
    expect(id).toBeTruthy();
    expect(seen).toEqual(["p1"]);
    expect(queue.isStarted()).toBe(false);
    await queue.start();
    expect(queue.isStarted()).toBe(true);
    await queue.stop();
  });

  it("in-memory adapter records schedules without firing (persistence is pg-boss's job)", async () => {
    const queue = new (await import("../src/index")).InMemoryJobQueue();
    await queue.schedule("tick", { cron: "* * * * *" });
    expect(queue.getSchedules()).toHaveLength(1);
  });

  it("pg-boss adapter defaults to the pgboss schema, DML-only runtime (no migration)", async () => {
    // The real adapter is exercised against Postgres in pgboss-adapter.test.ts;
    // here we pin the construction contract (no connection until start()).
    let factoryOptions: { schema: string } | null = null;
    const queue = new PgBossJobQueue({
      connectionString: "postgres://invalid",
      bossFactory: (options) => {
        factoryOptions = options;
        throw new Error("must not connect before start()");
      },
    });
    expect(queue.isStarted()).toBe(false);
    await expect(queue.start()).rejects.toThrow(/must not connect/);
    expect(factoryOptions).toMatchObject({ schema: "pgboss" });
    expect(queue.isStarted()).toBe(false);
  });
});

