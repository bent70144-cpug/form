import { describe, expect, it } from "vitest";
import { createHeartbeatWorker, HEARTBEAT_JOB } from "../src/worker";

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
} as never;

describe("worker", () => {
  it("starts the queue, logs a heartbeat and stops cleanly", async () => {
    const beats: Array<{ at: string }> = [];
    const worker = createHeartbeatWorker({
      logger: silentLogger,
      onHeartbeat: (payload) => beats.push(payload),
    });
    expect(worker.queue.isStarted()).toBe(false);
    await worker.start();
    expect(worker.queue.isStarted()).toBe(true);
    // The in-memory adapter executes enqueued jobs inline, so the immediate
    // heartbeat has already fired by the time start() resolves.
    expect(beats).toHaveLength(1);
    expect(new Date(beats[0]!.at).toString()).not.toBe("Invalid Date");
    await worker.stop();
    expect(worker.queue.isStarted()).toBe(false);
  });

  it("dispatches enqueued heartbeats to the registered handler", async () => {
    const beats: Array<{ at: string }> = [];
    const observing = createHeartbeatWorker({
      logger: silentLogger,
      onHeartbeat: (payload) => beats.push(payload),
    });
    await observing.queue.enqueue(HEARTBEAT_JOB, { at: "now" });
    expect(beats).toEqual([{ at: "now" }]);
  });
});
