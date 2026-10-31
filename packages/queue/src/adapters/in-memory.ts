import type {
  EnqueueOptions,
  JobHandler,
  JobPayload,
  JobQueue,
  ScheduleOptions,
} from "../port";

interface Registration {
  handler: JobHandler<never>;
}

/**
 * In-memory adapter for M0: the worker is runnable (heartbeats, handler
 * registration) before pg-boss exists. Jobs are executed immediately
 * (fire-and-forget); schedules are recorded but never fire — persistence is
 * exactly what pg-boss (ticket 02/05) will provide.
 */
export class InMemoryJobQueue implements JobQueue {
  private readonly registrations = new Map<string, Registration>();
  private readonly scheduled: Array<{
    name: string;
    options: ScheduleOptions;
    payload?: JobPayload;
  }> = [];
  private started = false;
  private seq = 0;

  registerHandler<P extends JobPayload>(name: string, handler: JobHandler<P>): void {
    this.registrations.set(name, { handler: handler as unknown as JobHandler<never> });
  }

  async enqueue<P extends JobPayload>(
    name: string,
    payload: P,
    _options?: EnqueueOptions,
  ): Promise<{ id: string }> {
    this.seq += 1;
    const id = `inmem-${this.seq}`;
    const registration = this.registrations.get(name);
    if (registration) {
      // Fire-and-forget like a real queue's dispatch; errors surface via the
      // returned promise chain of the handler itself.
      await (registration.handler as JobHandler<P>)(payload, {
        jobId: id,
        name,
        attempt: 1,
      });
    }
    return { id };
  }

  async schedule(
    name: string,
    options: ScheduleOptions,
    payload?: JobPayload,
  ): Promise<void> {
    this.scheduled.push({ name, options, payload });
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  /** Test/inspection helpers. */
  isStarted(): boolean {
    return this.started;
  }

  getSchedules(): ReadonlyArray<{ name: string; options: ScheduleOptions }> {
    return this.scheduled;
  }
}

export function createInMemoryQueue(): JobQueue {
  return new InMemoryJobQueue();
}
