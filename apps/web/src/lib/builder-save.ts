/**
 * Serialized draft saves (ticket 08).
 *
 * Guarantees (spec: "Draft saves are serialized so one tab cannot conflict
 * with its own in-flight save"):
 * - `schedule()` debounces bursts of edits (trailing window) and coalesces
 *   them into ONE request carrying the latest schema.
 * - A save scheduled while another is IN FLIGHT is queued (latest wins) and
 *   starts only after the in-flight request settles.
 * - The optimistic token is the saver's OWN last-seen `draftVersion`: a queued
 *   save uses the version returned by the save that just completed, never the
 *   stale one captured at schedule time.
 * - A 409 `draft_conflict` HALTS the saver: every current and future schedule
 *   resolves with `conflict` and no further requests are sent. The UI shows
 *   its reload state instead of silently overwriting the other tab.
 * - Transient failures (network, 5xx, malformed body) resolve `error` and do
 *   NOT halt autosaving; the next edit retries.
 *
 * All requests go through the SAME-ORIGIN `/v1/*` rewrite — never the
 * internal API URL (the Origin guard has no internal-call exemption; same
 * rule as lib/forms-client.ts). The `fetchImpl` seam keeps this unit-testable
 * without a browser.
 */
import { draftSaveResponseSchema } from "@form/contracts";

export type SaveOutcome =
  | { kind: "saved"; draftVersion: number }
  | { kind: "superseded" }
  | { kind: "error" }
  | { kind: "conflict" };

export interface DraftSaver {
  /** Debounced, coalesced, serialized save of the full draft schema. */
  schedule(schema: unknown): Promise<SaveOutcome>;
  /** The last-seen optimistic token (updated by successful saves only). */
  readonly lastSeenVersion: number;
}

const DEFAULT_DEBOUNCE_MS = 500;

export function createDraftSaver(options: {
  formId: string;
  initialDraftVersion: number;
  debounceMs?: number;
  fetchImpl?: typeof fetch;
}): DraftSaver {
  const doFetch = options.fetchImpl ?? fetch;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const url = `/v1/forms/${options.formId}/draft`;

  let lastSeen = options.initialDraftVersion;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let halted = false;
  let queued: { schema: unknown; resolve: (outcome: SaveOutcome) => void } | null =
    null;

  function send(schema: unknown): Promise<SaveOutcome> {
    return doFetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ schema, draftVersion: lastSeen }),
    })
      .then(async (res): Promise<SaveOutcome> => {
        if (res.status === 409) return { kind: "conflict" };
        if (!res.ok) return { kind: "error" };
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const parsed = draftSaveResponseSchema.safeParse(body);
        if (!parsed.success) return { kind: "error" };
        lastSeen = parsed.data.draftVersion;
        return { kind: "saved", draftVersion: parsed.data.draftVersion };
      })
      .catch((): SaveOutcome => ({ kind: "error" }));
  }

  function settleQueuedAsConflict(): void {
    if (queued) {
      const pending = queued;
      queued = null;
      pending.resolve({ kind: "conflict" });
    }
  }

  function pump(): void {
    if (halted) {
      settleQueuedAsConflict();
      return;
    }
    if (!queued || inFlight) return;
    const next = queued;
    queued = null;
    inFlight = true;
    void send(next.schema).then((outcome) => {
      inFlight = false;
      if (outcome.kind === "conflict") halted = true;
      next.resolve(outcome);
      if (halted) settleQueuedAsConflict();
      else pump();
    });
  }

  return {
    schedule(schema: unknown): Promise<SaveOutcome> {
      if (halted) return Promise.resolve({ kind: "conflict" });
      if (timer !== null) clearTimeout(timer);
      if (queued) {
        const stale = queued;
        queued = null;
        stale.resolve({ kind: "superseded" });
      }
      return new Promise((resolve) => {
        queued = { schema, resolve };
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, debounceMs);
      });
    },

    get lastSeenVersion(): number {
      return lastSeen;
    },
  };
}
