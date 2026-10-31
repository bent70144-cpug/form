import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBossJobQueue } from "../src/index";
import {
  setupQueueTest,
  teardownQueueTest,
  type QueueTestContext,
} from "./setup";

/**
 * pg-boss adapter suites: DIRECT connection as worker_user (DML-only,
 * migration skipped — the DDL was installed by the migrator in setup).
 */

let ctx: QueueTestContext;

beforeAll(async () => {
  ctx = await setupQueueTest();
});

afterAll(async () => {
  await teardownQueueTest(ctx);
});

describe("PgBossJobQueue (JobQueue port, real pg-boss)", () => {
  it("start/stop is idempotent and flips isStarted", async () => {
    const queue = new PgBossJobQueue({
      connectionString: ctx.urls.workerUrl,
    });
    expect(queue.isStarted()).toBe(false);
    await queue.start();
    expect(queue.isStarted()).toBe(true);
    await queue.start(); // idempotent
    expect(queue.isStarted()).toBe(true);
    await queue.stop();
    expect(queue.isStarted()).toBe(false);
    await queue.stop(); // idempotent
  });

  it("enqueues a job and the registered handler receives payload + context", async () => {
    const queue = new PgBossJobQueue({
      connectionString: ctx.urls.workerUrl,
      batchSize: 1,
    });
    const received: Array<{ payload: unknown; jobId: string; attempt: number }> = [];
    queue.registerHandler<{ n: number }>("adapter.ping", (payload, context) => {
      received.push({ payload, jobId: context.jobId, attempt: context.attempt });
    });
    await queue.start();
    try {
      const { id } = await queue.enqueue("adapter.ping", { n: 41 });
      // pg-boss 12.38 job ids are uuids.
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const deadline = Date.now() + 15_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(received).toEqual([
        { payload: { n: 41 }, jobId: id, attempt: 1 },
      ]);
    } finally {
      await queue.stop();
    }
  }, 25_000);

  it("delayed enqueues are not delivered immediately", async () => {
    const queue = new PgBossJobQueue({
      connectionString: ctx.urls.workerUrl,
    });
    let calls = 0;
    queue.registerHandler("adapter.delayed", () => {
      calls += 1;
    });
    await queue.start();
    try {
      await queue.enqueue("adapter.delayed", {}, { delayMs: 10_000 });
      await new Promise((r) => setTimeout(r, 1_500));
      expect(calls).toBe(0);
    } finally {
      await queue.stop();
    }
  }, 25_000);

  it("schedules a recurring cron job that fires repeatedly across 60s throttle slots", async () => {
    // pg-boss 12.38 collapses sub-minute cron expressions into ONE job per
    // 60-second occurrence slot (timekeeper's throttleSlot) — so a 1s cron
    // fires once per minute. The test asserts recurrence across two slots;
    // this is also why the dispatcher's 30s strategy effectively ticks
    // ~once/minute (documented in docs/adr/0005-outbox-dispatcher.md).
    const queue = new PgBossJobQueue({
      connectionString: ctx.urls.workerUrl,
    });
    const fires: Array<{ jobId: string; sequence: number }> = [];
    queue.registerHandler<{ sequence: number }>("adapter.tick", (payload, context) => {
      fires.push({ jobId: context.jobId, sequence: payload.sequence });
    });
    await queue.start();
    try {
      await queue.schedule("adapter.tick", { cron: "*/1 * * * * *" }, { sequence: 7 });
      const deadline = Date.now() + 75_000;
      while (fires.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(fires.length).toBeGreaterThanOrEqual(2);
      expect(fires[0]!.sequence).toBe(7);
      // Distinct job ids: each fire is its own queue job.
      expect(fires[0]!.jobId).not.toBe(fires[1]!.jobId);
      expect(queue.getSchedules()[0]).toMatchObject({
        name: "adapter.tick",
        options: { cron: "*/1 * * * * *" },
      });
    } finally {
      await queue.stop();
    }
  }, 90_000);

  it("schedules a cron job that fires within the cron-monitor window", async () => {
    // Fast recurrence check (T02 heartbeat pattern): first scheduled fire
    // lands within ~interval + 10s thanks to cronMonitorIntervalSeconds: 5.
    const queue = new PgBossJobQueue({
      connectionString: ctx.urls.workerUrl,
    });
    const fires: string[] = [];
    queue.registerHandler("adapter.fast", (_payload, context) => {
      fires.push(context.jobId);
    });
    await queue.start();
    try {
      await queue.schedule("adapter.fast", { cron: "*/1 * * * * *" });
      const deadline = Date.now() + 15_000;
      while (fires.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(fires.length).toBeGreaterThanOrEqual(1);
    } finally {
      await queue.stop();
    }
  }, 25_000);
});
