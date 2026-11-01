import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import PublicFormClient from "../src/app/f/[slug]/PublicFormClient";
import {
  createPublicSession,
  sessionTokenStorageKey,
  submitPublicAnswers,
} from "../src/app/f/[slug]/public-session-client";
import {
  blankRequiredBlocks,
  mapFieldErrors,
  phaseForSubmitProblem,
  welcomeBlock,
  endingBlock,
} from "../src/app/f/[slug]/public-form-machine";
import type { FormBlock } from "@form/contracts";
import { en } from "@form/i18n";

/**
 * Ticket 10 — the INTERACTIVE public form slice (web side).
 *
 * The page's data layer is covered at the API seam (apps/api/test/
 * public-*.test.ts). Here we pin:
 * - the pure submission semantics (machine): 422 keeps the form with
 *   per-field errors; closed/expired map to their screens; the client-side
 *   required check counts whitespace-only as empty (server stays
 *   authoritative);
 * - the browser client: session creation POSTs the cookie-less sessions
 *   route through the same-origin /v1 rewrite, submit sends X-Form-Session,
 *   both parse through the shared contracts, nothing throws on foreign
 *   responses;
 * - the rendered form: every input has a programmatically associated label,
 *   inputs are fluid (`width:100%`, border-box — 360px-safe by
 *   construction), and the submit button is disabled until the session is
 *   active.
 *
 * NOTE (sandbox deviation): Playwright browsers are not installed in this
 * environment (3.6 GB RAM / disk budget), so the 360px viewport check is
 * asserted at the CSS-construction level (no fixed widths, fluid inputs)
 * instead of a real browser viewport render.
 */

const SLUG = "abc1234567";

function envelope(overrides: Record<string, unknown> = {}): {
  schemaVersion: number;
  title: string;
  blocks: FormBlock[];
  logic: unknown[];
  theme: { preset: string };
  settings: Record<string, never>;
} {
  return {
    schemaVersion: 1,
    title: "Feedback survey",
    blocks: [
      { id: "welcome00001", kind: "welcome", title: "Hello there" },
      {
        id: "question0001",
        kind: "short_text",
        label: "Your name",
        required: true,
        placeholder: "Ada Lovelace",
      },
      { id: "question0002", kind: "long_text", label: "Feedback", required: false },
      { id: "ending000001", kind: "ending", title: "Thank you!" },
    ],
    logic: [],
    theme: { preset: "default" },
    settings: {},
    ...overrides,
  } as Parameters<typeof PublicFormClient>[0]["schema"] extends never ? never : never;
}

function render(component: ReactElement): string {
  return renderToStaticMarkup(component);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("public form machine (pure submission semantics)", () => {
  it("maps 422 field errors per block (answers.<blockId> paths)", () => {
    const fieldErrors = mapFieldErrors({
      type: "https://form.example/errors/validation",
      title: "Validation failed",
      status: 422,
      code: "validation_failed",
      errors: [
        { path: "answers.question0001", code: "required_answer_missing", message: "x" },
        { path: "answers.question0002", code: "answer_too_long", message: "x" },
        { path: "answers", code: "submission_too_large", message: "x" },
      ],
    });
    expect(fieldErrors).toEqual({
      question0001: "required_answer_missing",
      question0002: "answer_too_long",
    });
  });

  it("maps submit problems onto phases: closed, expired, form (422), error", () => {
    const problem = (code: string, status: number) => ({
      type: "https://form.example/errors/x",
      title: "t",
      status,
      code,
    });
    expect(phaseForSubmitProblem(problem("form_closed", 409), 409)).toBe("closed");
    expect(phaseForSubmitProblem(problem("session_expired", 410), 410)).toBe("expired");
    expect(phaseForSubmitProblem(problem("session_not_found", 404), 404)).toBe("expired");
    expect(phaseForSubmitProblem(problem("validation_failed", 422), 422)).toBe("form");
    expect(phaseForSubmitProblem(problem("form_full", 409), 409)).toBe("error");
    expect(phaseForSubmitProblem(null, 500)).toBe("error");
  });

  it("client-side required check counts whitespace-only as empty (convenience only)", () => {
    const blocks = envelope().blocks;
    expect(blankRequiredBlocks(blocks, {})).toEqual(["question0001"]);
    expect(blankRequiredBlocks(blocks, { question0001: "   " })).toEqual(["question0001"]);
    expect(blankRequiredBlocks(blocks, { question0001: " Ada " })).toEqual([]);
    // Optional long_text never blocks.
    expect(blankRequiredBlocks(blocks, { question0001: "a", question0002: "" })).toEqual([]);
  });

  it("finds the welcome and ending blocks", () => {
    const blocks = envelope().blocks;
    expect(welcomeBlock(blocks)?.id).toBe("welcome00001");
    expect(endingBlock(blocks)?.id).toBe("ending000001");
  });
});

describe("public session browser client", () => {
  it("creates a session through the same-origin /v1 rewrite, no credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        token: "AbC123def456ghi789jkl012mno345pqr678stuv901",
        expiresAt: "2026-11-01T12:00:00.000Z",
        pinnedVersionId: "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b",
        schema: envelope(),
      }),
    );
    const result = await createPublicSession(SLUG, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.session.pinnedVersionId).toBe("018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b");
    }
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`/v1/public/forms/${SLUG}/sessions`);
    expect(init?.method).toBe("POST");
    expect((init as RequestInit).cache).toBe("no-store");
    expect(init?.credentials).not.toBe("include");
  });

  it("submits with the X-Form-Session header and parses the receipt", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        submitted: true,
        submissionId: "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b",
      }),
    );
    const result = await submitPublicAnswers("tok", { question0001: "Ada" }, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.submitted).toBe(true);
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-form-session")).toBe("tok");
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ answers: { question0001: "Ada" } }),
    );
  });

  it("maps a 422 problem body onto a failure result with the parsed problem", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(422, {
        type: "https://form.example/errors/validation",
        title: "Validation failed",
        status: 422,
        code: "validation_failed",
        errors: [
          { path: "answers.question0001", code: "required_answer_missing", message: "x" },
        ],
      }),
    );
    const result = await submitPublicAnswers("tok", {}, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.problem?.code).toBe("validation_failed");
      expect(phaseForSubmitProblem(result.problem, result.status)).toBe("form");
      expect(mapFieldErrors(result.problem!)["question0001"]).toBe("required_answer_missing");
    }
  });

  it("keys the sessionStorage token per slug", () => {
    expect(sessionTokenStorageKey(SLUG)).toBe(`form-session:${SLUG}`);
  });
});

describe("PublicFormClient (rendered, initial state)", () => {
  it("renders every input with a programmatically associated label and a fluid 360px-safe layout", () => {
    const html = render(createElement(PublicFormClient, { slug: SLUG, schema: envelope() as never }));
    // label[for] ↔ input[id] association for BOTH questions.
    expect(html).toContain('for="f-question0001"');
    expect(html).toContain('id="f-question0001"');
    expect(html).toContain('for="f-question0002"');
    expect(html).toContain('id="f-question0002"');
    // Placeholder + i18n marks come from the catalog.
    expect(html).toContain(en.public.form.requiredMark);
    expect(html).toContain(en.public.form.optionalMark);
    // 360px-safe by construction: fluid inputs + border-box + stacked form.
    expect(html).toContain("width:100%");
    expect(html).toContain("box-sizing:border-box");
    expect(html).toContain("flex-direction:column");
    // No fixed pixel widths on any input (the only fixed numbers are the
    // container's max-width, which never forces overflow).
    expect(html).not.toMatch(/<input[^>]*width:\s*\d+px/);
  });

  it("keeps the submit disabled until the pinned session is active (created on mount)", () => {
    const html = render(createElement(PublicFormClient, { slug: SLUG, schema: envelope() as never }));
    expect(html).toContain(en.public.form.sessionStarting);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain(en.public.form.submitButton);
  });
});
