import type { EnqueueOptions, JobHandler, JobPayload, JobQueue, ScheduleOptions } from "../port";
/**
 * In-memory adapter for M0: the worker is runnable (heartbeats, handler
 * registration) before pg-boss exists. Jobs are executed immediately
 * (fire-and-forget); schedules are recorded but never fire — persistence is
 * exactly what pg-boss (ticket 02/05) will provide.
 */
export declare class InMemoryJobQueue implements JobQueue {
    private readonly registrations;
    private readonly scheduled;
    private started;
    private seq;
    registerHandler<P extends JobPayload>(name: string, handler: JobHandler<P>): void;
    enqueue<P extends JobPayload>(name: string, payload: P, _options?: EnqueueOptions): Promise<{
        id: string;
    }>;
    schedule(name: string, options: ScheduleOptions, payload?: JobPayload): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Test/inspection helpers. */
    isStarted(): boolean;
    getSchedules(): ReadonlyArray<{
        name: string;
        options: ScheduleOptions;
    }>;
}
export declare function createInMemoryQueue(): JobQueue;
//# sourceMappingURL=in-memory.d.ts.map