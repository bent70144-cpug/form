"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryJobQueue = void 0;
exports.createInMemoryQueue = createInMemoryQueue;
/**
 * In-memory adapter for M0: the worker is runnable (heartbeats, handler
 * registration) before pg-boss exists. Jobs are executed immediately
 * (fire-and-forget); schedules are recorded but never fire — persistence is
 * exactly what pg-boss (ticket 02/05) will provide.
 */
class InMemoryJobQueue {
    registrations = new Map();
    scheduled = [];
    started = false;
    seq = 0;
    registerHandler(name, handler) {
        this.registrations.set(name, { handler: handler });
    }
    async enqueue(name, payload, _options) {
        this.seq += 1;
        const id = `inmem-${this.seq}`;
        const registration = this.registrations.get(name);
        if (registration) {
            // Fire-and-forget like a real queue's dispatch; errors surface via the
            // returned promise chain of the handler itself.
            await registration.handler(payload, {
                jobId: id,
                name,
                attempt: 1,
            });
        }
        return { id };
    }
    async schedule(name, options, payload) {
        this.scheduled.push({ name, options, payload });
    }
    async start() {
        this.started = true;
    }
    async stop() {
        this.started = false;
    }
    /** Test/inspection helpers. */
    isStarted() {
        return this.started;
    }
    getSchedules() {
        return this.scheduled;
    }
}
exports.InMemoryJobQueue = InMemoryJobQueue;
function createInMemoryQueue() {
    return new InMemoryJobQueue();
}
//# sourceMappingURL=in-memory.js.map