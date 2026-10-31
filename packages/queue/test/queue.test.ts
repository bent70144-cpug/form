import { describe, expect, it } from "vitest";
import { createInMemoryQueue, PgBossQueueStub } from "../src/index";

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

  it("pg-boss adapter is a stub pointing to tickets 02/05", async () => {
    const stub = new PgBossQueueStub();
    expect(() => stub.registerHandler("x", () => {})).toThrow(/02\/05/);
    await expect(stub.enqueue("x", {})).rejects.toThrow(/02\/05/);
  });
});
