import type { OutboxHandler } from "@form/queue";

/**
 * First outbox handler (ticket 05): `workspace.created`.
 *
 * `create_personal_workspace()` inserts the event with payload
 * `{ workspaceId, userId }` (migration 0006) — the workspace id travels in
 * the payload because outbox_events has no workspace_id column. The M0
 * handler logs a structured event only; the real workspace UX lands with
 * ticket 05's API slice.
 *
 * Idempotency contract (docs/adr/0005-outbox-dispatcher.md): structured
 * logging is naturally replayable — a redelivered event just logs again.
 */
export const WORKSPACE_CREATED_EVENT = "workspace.created";

export function createWorkspaceCreatedHandler(logger: {
  info(line: Record<string, unknown>, message?: string): void;
}): OutboxHandler {
  return (event) => {
    const payload = event.payload as {
      workspaceId?: unknown;
      userId?: unknown;
    };
    logger.info(
      {
        event: "outbox.workspace_created",
        outboxEventId: event.id,
        workspaceId:
          typeof payload.workspaceId === "string" ? payload.workspaceId : null,
        userId: typeof payload.userId === "string" ? payload.userId : null,
        attempts: event.attempts,
      },
      "workspace.created",
    );
  };
}
