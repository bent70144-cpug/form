import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftSaver } from "../src/lib/builder-save";

/**
 * Ticket 08 — serialized draft saves.
 *
 * Pins the spec guarantee "Draft saves are serialized so one tab cannot
 * conflict with its own in-flight save": a debounced, coalesced schedule, at
 * most ONE in-flight PUT (the next save queues behind it, carrying the
 * version returned by the previous save), a 409 `draft_conflict` HALTS
 * autosaving (no further requests; the UI shows its reload state), and
 * transient errors do not halt.
 */

const FORM_ID = "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b";

function schema(label: string): unknown {
  return {
    schemaVersion: 1,
    title: label,
    blocks: [],
    logic: [],
    theme: { preset: "default" },
    settings: {},
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeSaver(initialDraftVersion = 3) {
  const gates: Array<(res: Response) => void> = [];
  const fetchImpl = vi.fn<typeof fetch>(() => {
    let resolve!: (res: Response) => void;
    const promise = new Promise<Response>((r) => {
      resolve = r;
    });
    gates.push(resolve);
    return promise;
  });
  const saver = createDraftSaver({
    formId: FORM_ID,
    initialDraftVersion,
    debounceMs: 500,
    fetchImpl,
  });
  return { saver, fetchImpl, gates };
}

function urlCalls(fetchImpl: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
  return fetchImpl.mock.calls.map((call) => [call[0] as string, call[1] as RequestInit]);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDraftSaver — debounce and wire shape", () => {
  it("sends ONE PUT /v1/forms/{id}/draft after the debounce window with the last-seen version", async () => {
    const { saver, fetchImpl, gates } = makeSaver(3);
    const first = saver.schedule(schema("A"));

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = urlCalls(fetchImpl)[0]!;
    expect(url).toBe(`/v1/forms/${FORM_ID}/draft`);
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({
      schema: schema("A"),
      draftVersion: 3,
    });

    gates[0]!(jsonResponse(200, { draftVersion: 4 }));
    await expect(first).resolves.toEqual({ kind: "saved", draftVersion: 4 });
    expect(saver.lastSeenVersion).toBe(4);
  });

  it("coalesces a burst of edits into one request (the latest schema wins)", async () => {
    const { saver, fetchImpl, gates } = makeSaver(0);
    const first = saver.schedule(schema("first"));
    const second = saver.schedule(schema("second"));

    // The superseded schedule resolves immediately and sends nothing.
    await expect(first).resolves.toEqual({ kind: "superseded" });

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(urlCalls(fetchImpl)[0]![1].body)).schema).toEqual(schema("second"));

    gates[0]!(jsonResponse(200, { draftVersion: 1 }));
    await expect(second).resolves.toEqual({ kind: "saved", draftVersion: 1 });
  });
});

describe("createDraftSaver — serialization (one tab never conflicts with itself)", () => {
  it("queues the next save BEHIND the in-flight one and carries the returned version", async () => {
    const { saver, fetchImpl, gates } = makeSaver(3);

    const first = saver.schedule(schema("first"));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Scheduled while the first PUT is still in flight: no second request yet.
    const second = saver.schedule(schema("second"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // First save lands → the queued save starts with the NEW last-seen version.
    gates[0]!(jsonResponse(200, { draftVersion: 4 }));
    await expect(first).resolves.toEqual({ kind: "saved", draftVersion: 4 });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, secondInit] = urlCalls(fetchImpl)[1]!;
    expect(JSON.parse(String(secondInit.body))).toEqual({
      schema: schema("second"),
      draftVersion: 4,
    });

    gates[1]!(jsonResponse(200, { draftVersion: 5 }));
    await expect(second).resolves.toEqual({ kind: "saved", draftVersion: 5 });
    expect(saver.lastSeenVersion).toBe(5);
  });

  it("resolves an in-flight-shadowed schedule as superseded — it never sends its own request", async () => {
    const { saver, fetchImpl, gates } = makeSaver(3);

    const first = saver.schedule(schema("first"));
    await vi.advanceTimersByTimeAsync(500);
    const second = saver.schedule(schema("second"));
    const third = saver.schedule(schema("third")); // replaces the queued second

    await expect(second).resolves.toEqual({ kind: "superseded" });
    gates[0]!(jsonResponse(200, { draftVersion: 4 }));
    await expect(first).resolves.toEqual({ kind: "saved", draftVersion: 4 });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(urlCalls(fetchImpl)[1]![1].body)).schema).toEqual(schema("third"));
    gates[1]!(jsonResponse(200, { draftVersion: 5 }));
    await expect(third).resolves.toEqual({ kind: "saved", draftVersion: 5 });
  });
});

describe("createDraftSaver — 409 draft_conflict halts autosaving", () => {
  it("returns conflict, sends nothing further, and future schedules never hit the wire", async () => {
    const { saver, fetchImpl, gates } = makeSaver(3);

    const first = saver.schedule(schema("stale"));
    await vi.advanceTimersByTimeAsync(500);
    gates[0]!(
      new Response(JSON.stringify({ code: "draft_conflict" }), {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      }),
    );
    await expect(first).resolves.toEqual({ kind: "conflict" });
    expect(saver.lastSeenVersion).toBe(3); // never adopted the stale path

    // Autosave is STOPPED: further edits schedule but no request goes out.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(saver.schedule(schema("more"))).resolves.toEqual({ kind: "conflict" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves a save queued behind the conflicting one as conflict (never overwrites)", async () => {
    const { saver, fetchImpl, gates } = makeSaver(3);

    const first = saver.schedule(schema("first"));
    await vi.advanceTimersByTimeAsync(500);
    const queued = saver.schedule(schema("second"));

    gates[0]!(
      new Response(JSON.stringify({ code: "draft_conflict" }), {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      }),
    );
    await expect(first).resolves.toEqual({ kind: "conflict" });
    await expect(queued).resolves.toEqual({ kind: "conflict" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createDraftSaver — transient errors do not halt autosaving", () => {
  it("resolves error on a 5xx and retries the next schedule", async () => {
    const { saver, fetchImpl, gates } = makeSaver(3);

    const first = saver.schedule(schema("a"));
    await vi.advanceTimersByTimeAsync(500);
    gates[0]!(jsonResponse(500, { title: "Unexpected error" }));
    await expect(first).resolves.toEqual({ kind: "error" });
    expect(saver.lastSeenVersion).toBe(3);

    const second = saver.schedule(schema("b"));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(urlCalls(fetchImpl)[1]![1].body)).draftVersion).toBe(3);
    gates[1]!(jsonResponse(200, { draftVersion: 4 }));
    await expect(second).resolves.toEqual({ kind: "saved", draftVersion: 4 });
  });

  it("resolves error on network failure and on a malformed success body", async () => {
    const failing = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    const saver1 = createDraftSaver({
      formId: FORM_ID,
      initialDraftVersion: 0,
      debounceMs: 500,
      fetchImpl: failing,
    });
    const first = saver1.schedule(schema("a"));
    await vi.advanceTimersByTimeAsync(500);
    await expect(first).resolves.toEqual({ kind: "error" });

    const { saver: saver2, gates, fetchImpl } = makeSaver(0);
    const second = saver2.schedule(schema("a"));
    await vi.advanceTimersByTimeAsync(500);
    gates[0]!(jsonResponse(200, { unexpected: true }));
    await expect(second).resolves.toEqual({ kind: "error" });
    expect(saver2.lastSeenVersion).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
