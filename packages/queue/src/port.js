"use strict";
/**
 * JobQueue port (spec: "The `JobQueue` port exposes enqueue, schedule, and
 * worker registration. The pg-boss adapter implements it now; BullMQ replaces
 * it at beta without changing domain code.").
 *
 * Ticket 01 delivers the port plus a no-op/in-memory adapter so the worker is
 * runnable before pg-boss lands (tickets 02/05). The pg-boss adapter is a
 * stubbed interface: it must use a DIRECT Postgres connection, never the
 * pooled application connection.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=port.js.map