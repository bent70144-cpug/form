import { PgBoss } from "pg-boss";
import type {
  EnqueueOptions,
  JobHandler,
  JobPayload,
  JobQueue,
  ScheduleOptions,
} from "../port";

/**
 * pg-boss adapter for the `JobQueue` port (spec section "Queue, outbox, and
 * audit": "The pg-boss adapter implements it now; BullMQ replaces it at beta
 * without changing domain code.").
 *
 * Topology rules (spec + docs/adr/0003-topology-spike.md):
 *   - connects with a DIRECT Postgres URL (WORKER_DATABASE_URL) — never the
 *     pooled application URL, because transaction-mode pooling breaks
 *     session-scoped features such as advisory locks;
 *   - uses the `pgboss` schema whose DDL is installed by the migrator; the
 *     adapter runs with `migrate: false` + `createSchema: false` so the
 *     runtime role stays DML-only and never migrates (ticket 02 verified the
 *     pg-boss 12.38 options);
 *   - `cronMonitorIntervalSeconds: 5` bounds first-fire latency of schedules
 *     created after start() to roughly interval + 10s (spike finding — the
 *     30s default would delay the dispatcher's first tick by up to 35s).
 *
 * The port needs no changes: registerHandler maps to `boss.work`, enqueue to
 * `boss.send` (delayMs → startAfter), schedule to `boss.schedule`.
 */

export interface PgBossQueueOptions {
  /** DIRECT connection string (worker role), not the pooled app URL. */
  connectionString: string;
  schema?: string;
  /** Error sink for pg-boss internal errors (default: stderr JSON line). */
  onError?: (error: unknown) => void;
  /** Batch size passed to `boss.work` (default 10). */
  batchSize?: number;
  /**
   * Policy for queues created by this adapter (default 'standard'). The
   * worker uses 'singleton' so overlapping cron ticks (heartbeat, outbox
   * dispatch) never stack while a previous tick is still running.
   */
  defaultQueuePolicy?: "standard" | "singleton" | "stately" | "flexible";
  /** Test seam: override the PgBoss factory. */
  bossFactory?: (options: {
    connectionString: string;
    schema: string;
  }) => PgBoss;
}

interface Registration {
  handler: JobHandler<never>;
}

export class PgBossJobQueue implements JobQueue {
  private readonly connectionString: string;
  private readonly schema: string;
  private readonly onError: (error: unknown) => void;
  private readonly batchSize: number;
  private readonly defaultQueuePolicy: PgBossQueueOptions["defaultQueuePolicy"];
  private readonly bossFactory: NonNullable<PgBossQueueOptions["bossFactory"]>;

  private boss: PgBoss | null = null;
  private readonly registrations = new Map<string, Registration>();
  private readonly scheduled: Array<{
    name: string;
    options: ScheduleOptions;
    payload?: JobPayload;
  }> = [];
  private readonly workedQueueNames = new Set<string>();
  private started = false;

  constructor(options: PgBossQueueOptions) {
    this.connectionString = options.connectionString;
    this.schema = options.schema ?? "pgboss";
    this.onError =
      options.onError ??
      ((error) =>
        process.stderr.write(
          JSON.stringify({
            event: "queue.pgboss_error",
            message: String(error),
          }) + "\n",
        ));
    this.batchSize = options.batchSize ?? 10;
    this.defaultQueuePolicy = options.defaultQueuePolicy;
    this.bossFactory =
      options.bossFactory ??
      ((bossOptions) =>
        new PgBoss({
          connectionString: bossOptions.connectionString,
          schema: bossOptions.schema,
          // DDL is owned by the migrator; the runtime role is DML-only.
          migrate: false,
          createSchema: false,
          // 5s monitor: a schedule created after start() produces its first
          // job within ~interval + 10s instead of +35s (spike finding).
          cronMonitorIntervalSeconds: 5,
          cronWorkerIntervalSeconds: 5,
        }));
  }

  registerHandler<P extends JobPayload>(name: string, handler: JobHandler<P>): void {
    this.registrations.set(name, {
      handler: handler as unknown as JobHandler<never>,
    });
    // If we are already running, attach the worker immediately; otherwise
    // start() attaches every registration.
    if (this.boss) {
      void this.attachWorker(name).catch(this.onError);
    }
  }

  async enqueue<P extends JobPayload>(
    name: string,
    payload: P,
    options?: EnqueueOptions,
  ): Promise<{ id: string }> {
    const boss = await this.ensureBoss();
    await this.ensureQueue(boss, name);
    const id = await boss.send(name, payload as object, {
      ...(options?.delayMs
        ? { startAfter: new Date(Date.now() + options.delayMs) }
        : {}),
    });
    // pg-boss returns null when send() is throttled/debounced away; the port
    // promises an id, so fail loudly instead of returning a phantom id.
    if (id === null) {
      throw new Error(`PgBossJobQueue: enqueue("${name}") was not accepted`);
    }
    return { id };
  }

  async schedule(
    name: string,
    options: ScheduleOptions,
    payload?: JobPayload,
  ): Promise<void> {
    const boss = await this.ensureBoss();
    await this.ensureQueue(boss, name);
    await boss.schedule(name, options.cron, (payload ?? {}) as object);
    this.scheduled.push({ name, options, payload });
  }

  async start(): Promise<void> {
    const boss = await this.ensureBoss();
    for (const name of this.registrations.keys()) {
      await this.attachWorker(name, boss);
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.boss) {
      this.started = false;
      return;
    }
    for (const name of this.workedQueueNames) {
      await this.boss.offWork(name).catch(() => undefined);
    }
    this.workedQueueNames.clear();
    await this.boss.stop({ graceful: false, timeout: 2000 });
    this.boss = null;
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Test/inspection helper: schedules recorded through the port. */
  getSchedules(): ReadonlyArray<{ name: string; options: ScheduleOptions }> {
    return this.scheduled;
  }

  /**
   * Lazy connection: start() connects explicitly, but enqueue/schedule before
   * start() also connect (jobs must persist even if the caller forgot to
   * start). stop() tears the connection down either way.
   */
  private async ensureBoss(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    const boss = this.bossFactory({
      connectionString: this.connectionString,
      schema: this.schema,
    });
    boss.on("error", this.onError);
    this.boss = await boss.start();
    return this.boss;
  }

  /** pg-boss 12 requires the queue to exist before work/send/schedule. */
  private async ensureQueue(boss: PgBoss, name: string): Promise<void> {
    if (!(await boss.getQueue(name))) {
      await boss.createQueue(name, {
        policy: this.defaultQueuePolicy ?? "standard",
      });
    }
  }

  private async attachWorker(
    name: string,
    boss: PgBoss | null = null,
  ): Promise<void> {
    const active = boss ?? this.boss;
    if (!active) return;
    const registration = this.registrations.get(name);
    if (!registration) return;
    await this.ensureQueue(active, name);
    await active.work<{ [key: string]: unknown }>(
      name,
      { batchSize: this.batchSize },
      async (jobs) => {
        for (const job of jobs) {
          await (registration.handler as JobHandler<JobPayload>)(job.data, {
            jobId: job.id,
            name,
            // retryCount = times re-claimed after earlier attempts.
            attempt: job.retryCount + 1,
          });
        }
      },
    );
    this.workedQueueNames.add(name);
  }
}

export function createPgBossQueue(options: PgBossQueueOptions): JobQueue {
  return new PgBossJobQueue(options);
}
