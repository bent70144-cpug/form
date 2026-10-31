import type { Logger } from "pino";
import {
  InMemoryJobQueue,
  type JobQueue,
  type ScheduleOptions,
} from "@form/queue";

/**
 * Worker runtime (spec: "The worker owns asynchronous processing"; ticket 01:
 * "the worker logs a heartbeat").
 *
 * M0 runs the in-memory JobQueue adapter: handler registration, enqueueing
 * and start/stop are exercised through the port, so swapping in the pg-boss
 * adapter (tickets 02/05) is a wiring change only.
 */
export const HEARTBEAT_JOB = "heartbeat";
export const HEARTBEAT_SCHEDULE: ScheduleOptions = { cron: "* * * * *" };

export interface HeartbeatWorker {
  queue: JobQueue;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createHeartbeatWorker(options: {
  logger: Logger;
  /** Test seam: called every time a heartbeat job runs. */
  onHeartbeat?: (payload: { at: string }) => void;
}): HeartbeatWorker {
  const queue = new InMemoryJobQueue();
  queue.registerHandler<{ at: string }>(HEARTBEAT_JOB, (payload) => {
    options.logger.info(payload, "worker heartbeat");
    options.onHeartbeat?.(payload);
  });

  return {
    queue,
    async start() {
      await queue.start();
      // Fire one heartbeat immediately, then on the documented interval. The
      // recurring schedule is recorded through the port now; pg-boss fires it
      // once it lands (in-memory schedules never fire by design).
      await queue.enqueue(HEARTBEAT_JOB, { at: new Date().toISOString() });
      options.logger.info({ schedule: HEARTBEAT_SCHEDULE.cron }, "heartbeat schedule registered");
      await queue.schedule(HEARTBEAT_JOB, HEARTBEAT_SCHEDULE);
    },
    async stop() {
      await queue.stop();
    },
  };
}
