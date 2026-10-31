import type { OutboxHandler } from "./dispatcher";

/**
 * M0 outbox handlers (ticket 05). Each handler MUST be idempotent: the
 * dispatcher commits the handler's writes and `processed_at` atomically, but
 * a crash between an external side effect and the commit can replay an event
 * (spec: "idempotent handlers").
 *
 * `workspace.created` — the outbox/audit foundation's first event, produced
 * by `create_personal_workspace()`. Processing is a no-op beyond the
 * processed_at mark (observability/log line): idempotent by construction,
 * and the payload (workspaceId, userId) is already durable. Handlers for
 * future events that touch tenant tables use `ctx.query` — the dispatcher
 * has set `app.workspace_id` from the payload under `worker_user`, so RLS
 * scopes every statement to the event's workspace.
 */
export function workspaceCreatedHandler(
  log: (obj: Record<string, unknown>, msg: string) => void = () => undefined,
): OutboxHandler {
  return async (event) => {
    log(
      {
        event: "outbox.workspace_created",
        workspaceId: event.payload.workspaceId,
        userId: event.payload.userId,
      },
      "workspace.created processed",
    );
  };
}

/** The registry wired into the dispatcher in `index.ts`. */
export function defaultOutboxHandlers(): Record<string, OutboxHandler> {
  return {
    "workspace.created": workspaceCreatedHandler(),
  };
}
