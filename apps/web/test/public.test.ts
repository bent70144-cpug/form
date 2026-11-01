import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import fs from "node:fs";
import path from "node:path";
import { fetchPublicForm } from "../src/app/f/[slug]/public-api-client";
import PublicFormView, {
  PublicFormClosed,
} from "../src/app/f/[slug]/PublicFormView";
import type { FormBlock } from "@form/contracts";
import { en } from "@form/i18n";

/**
 * Ticket 09 — the public /f/[slug] SSR slice.
 *
 * Behavioral guarantees (published/closed/redirect/not_found, no-store) are
 * proven at the API seam (apps/api/test/public.test.ts). Here we pin the
 * renderer guarantees the spec states on the PAGE:
 * - the SSR reader calls the UNauthenticated endpoint on the INTERNAL API URL
 *   with `cache: "no-store"` and `redirect: "manual"` (no cookies — the
 *   endpoint is cookie-less);
 * - ALL creator text renders ESCAPED (React default) — a label containing
 *   `<script>` renders as inert text, never markup;
 * - the closed message renders from the i18n catalog;
 * - the page is force-dynamic + noindex and maps statuses via notFound() /
 *   permanentRedirect().
 */

const WEB_ROOT = path.resolve(__dirname, "..");
const F_DIR = path.join(WEB_ROOT, "src", "app", "f", "[slug]");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(F_DIR, rel), "utf8");
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function render(component: ReactElement): string {
  return renderToStaticMarkup(component);
}

interface TestEnvelope {
  title: string;
  blocks: FormBlock[];
}

function envelope(overrides: Record<string, unknown> = {}): TestEnvelope {
  // The stable envelope shape (mirrors @form/form-schema's emptyDraft(); the
  // web package deliberately does not depend on the schema engine). Blocks are
  // typed with the shared wire contract (@form/contracts).
  return {
    title: "Feedback survey",
    blocks: [
      { id: "welcome00001", kind: "welcome", title: "Hello there" },
      {
        id: "question0001",
        kind: "short_text",
        label: "Your name",
        description: "As it appears on the ticket",
        required: true,
        placeholder: "Ada Lovelace",
      },
      {
        id: "question0002",
        kind: "long_text",
        label: "Feedback",
        required: false,
      },
      { id: "ending000001", kind: "ending", title: "Thank you!" },
    ],
    ...overrides,
  } as TestEnvelope;
}

/** The FULL wire envelope (the public contract's published variant is strict). */
function wireEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    title: "Feedback survey",
    blocks: envelope().blocks,
    logic: [],
    theme: { preset: "default" },
    settings: {},
  };
}

describe("fetchPublicForm (SSR reader)", () => {
  it("GETs /v1/public/forms/{slug} on the internal API URL with no-store + manual redirect", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { status: "published" }),
    );
    await fetchPublicForm("abc1234567", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/public\/forms\/abc1234567$/);
    expect(init?.cache).toBe("no-store");
    expect((init as RequestInit).redirect).toBe("manual");
  });

  it("maps the four API statuses", async () => {
    const published = await fetchPublicForm("s", {
      fetchImpl: async () =>
        jsonResponse(200, {
          status: "published",
          formId: "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b",
          versionId: "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7c",
          versionNumber: 2,
          schema: wireEnvelope(),
        }),
    });
    expect(published.status).toBe("published");
    expect(published.status === "published" && published.versionNumber).toBe(2);

    const closed = await fetchPublicForm("s", {
      fetchImpl: async () => jsonResponse(200, { status: "closed" }),
    });
    expect(closed).toEqual({ status: "closed" });

    const redirect = await fetchPublicForm("s", {
      fetchImpl: async () =>
        new Response(null, { status: 308, headers: { location: "/f/can0nical0" } }),
    });
    expect(redirect).toEqual({ status: "redirect", canonicalSlug: "can0nical0" });

    const notFound = await fetchPublicForm("s", {
      fetchImpl: async () =>
        jsonResponse(404, { code: "not_found" }, { "cache-control": "no-store" }),
    });
    expect(notFound).toEqual({ status: "not_found" });

    const down = await fetchPublicForm("s", {
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    expect(down).toEqual({ status: "not_found" });
  });
});

describe("PublicFormView (escaped, read-only, 360px-safe)", () => {
  it("renders every block kind and keeps creator text as TEXT — <script> never becomes markup", () => {
    const hostile = envelope({
      title: 'Title <script>alert("title")</script>',
      blocks: [
        { id: "welcome00001", kind: "welcome", title: "Welcome <script>alert(1)</script>" },
        {
          id: "question0001",
          kind: "short_text",
          label: "Name <script>alert(2)</script>",
          description: "Desc <img src=x onerror=alert(3)>",
          required: true,
          placeholder: "Ph <script>alert(4)</script>",
        },
        { id: "ending000001", kind: "ending", title: "End <script>alert(5)</script>" },
      ],
    });

    const html = render(createElement(PublicFormView, { title: hostile.title, blocks: hostile.blocks }));

    // Everything is ESCAPED: no <script> tag, no <img> tag, no live attribute.
    expect(html).not.toMatch(/<script[\s>]/);
    expect(html).not.toMatch(/<img[\s>]/);
    expect(html).not.toMatch(/<section[^>]*onerror/);
    // ...but the TEXT is all there, escaped exactly as React does.
    expect(html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
    expect(html).toContain("Welcome &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Name &lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("Desc &lt;img src=x onerror=alert(3)&gt;");
    expect(html).toContain("End &lt;script&gt;alert(5)&lt;/script&gt;");
    // The script payload never executes: it exists only as entities.
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders questions as DISABLED inputs with programmatically associated labels (no session created)", () => {
    const html = render(
      createElement(PublicFormView, {
        title: "Feedback survey",
        blocks: envelope().blocks,
      }),
    );
    expect(html).toContain('for="f-question0001"');
    expect(html).toContain('id="f-question0001"');
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toContain(`(${en.public.form.requiredMark})`);
    expect(html).toContain(`(${en.public.form.optionalMark})`);
    // Inputs are fluid: 360px-safe by construction.
    expect(html).toContain("width:100%");
  });

  it("renders the closed message from the i18n catalog", () => {
    const html = render(createElement(PublicFormClosed));
    expect(html).toContain(en.public.form.closedTitle);
    expect(html).toContain(en.public.form.closedDetail);
  });
});

describe("public page source contracts (ticket 09)", () => {
  it("page maps statuses: notFound() for unknown, permanentRedirect for superseded slugs, closed message", () => {
    const source = readSource("page.tsx");
    expect(source).toContain('dynamic = "force-dynamic"');
    expect(source).toContain("notFound()");
    expect(source).toContain("permanentRedirect");
    expect(source).toContain("fetchPublicForm");
    // noindex metadata.
    expect(source).toContain("index: false");
  });

  it("the SSR reader never touches the same-origin rewrite or browser mutation helpers", () => {
    const client = readSource("public-api-client.ts");
    expect(client).toContain("internalApiUrl");
    expect(client).not.toContain("/v1/auth/session");
    expect(client).not.toContain("credentials");
  });
});
