import type { OutboxHandler } from "@form/queue";

/**
 * Outbox handler for `form.created` (ticket 06).
 *
 * `FormsService.create` inserts the event with payload
 * `{ workspaceId, formId, userId }` in the same transaction as the form row
 * (the workspace id travels in the payload because outbox_events has no
 * workspace_id column). M0 has no downstream work to fan out for a new form,
 * so — like `workspace.created` — the handler logs a structured event only.
 *
 * Idempotency contract (docs/adr/0005-outbox-dispatcher.md): structured
 * logging is naturally replayable — a redelivered event just logs again.
 */
export const FORM_CREATED_EVENT = "form.created";

export function createFormCreatedHandler(logger: {
  info(line: Record<string, unknown>, message?: string): void;
}): OutboxHandler {
  return (event) => {
    const payload = event.payload as {
      workspaceId?: unknown;
      formId?: unknown;
      userId?: unknown;
    };
    logger.info(
      {
        event: "outbox.form_created",
        outboxEventId: event.id,
        workspaceId:
          typeof payload.workspaceId === "string" ? payload.workspaceId : null,
        formId: typeof payload.formId === "string" ? payload.formId : null,
        userId: typeof payload.userId === "string" ? payload.userId : null,
        attempts: event.attempts,
      },
      "form.created",
    );
  };
}
