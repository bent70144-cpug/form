import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { en, t } from "@form/i18n";
import type { FormDraftSchema } from "@form/contracts";
import {
  pairAnswersWithBlocks,
  type PairedAnswer,
} from "../src/app/dashboard/forms/[id]/inbox/pairing";

/**
 * Ticket 11 — dashboard inbox (source contracts + logic seams).
 *
 * The API slice (GET /v1/forms/{formId}/submissions[/id]) is covered by the
 * API suite (apps/api/test/submissions-list.test.ts); here we pin the UI
 * side: the answer/question pairing runs STRICTLY from the PINNED version's
 * schema (never a "current draft"), labels and answers stay plain escaped
 * text (no dangerouslySetInnerHTML), pagination follows the API's opaque
 * cursor, and every inbox string — labels, empty states, dates, errors — is
 * an i18n key that exists in the catalog.
 */

const WEB_ROOT = path.resolve(__dirname, "..");
const INBOX_DIR = path.join(
  WEB_ROOT,
  "src/app/dashboard/forms/[id]/inbox",
);

function readWebSource(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

function inboxSources(): string[] {
  return fs
    .readdirSync(INBOX_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      fs.readFileSync(path.join(entry.parentPath ?? INBOX_DIR, entry.name), "utf8"),
    );
}

function envelope(
  blocks: FormDraftSchema["blocks"],
): FormDraftSchema {
  return {
    schemaVersion: 1,
    title: "Feedback",
    blocks,
    logic: [],
    theme: { preset: "default" },
    settings: {},
  };
}

describe("pairAnswersWithBlocks (pinned-schema pairing)", () => {
  const Q_NAME = "a0000000001";
  const Q_STORY = "a0000000002";
  const schema = envelope([
    { id: "b_welcome", kind: "welcome", title: "Welcome" },
    { id: Q_NAME, kind: "short_text", label: "Your name", required: true },
    { id: Q_STORY, kind: "long_text", label: "Your story", required: false },
    { id: "b_end", kind: "ending", title: "Thanks!" },
  ]);

  it("pairs each answer beside the question label, in the form's block order", () => {
    const rows = pairAnswersWithBlocks(schema, {
      [Q_NAME]: "Ada Lovelace",
      [Q_STORY]: "Analytical engines",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      blockId: Q_NAME,
      label: "Your name",
      required: true,
      isQuestion: true,
      answer: "Ada Lovelace",
    });
    expect(rows[1]).toMatchObject({
      blockId: Q_STORY,
      label: "Your story",
      required: false,
      isQuestion: true,
      answer: "Analytical engines",
    });
  });

  it("an unanswered optional question renders the no-answer state, not a crash", () => {
    const rows = pairAnswersWithBlocks(schema, { [Q_NAME]: "Ada Lovelace" });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.answer).toBeNull();
  });

  it("an answer without a matching pinned question gets the fallback label", () => {
    const rows = pairAnswersWithBlocks(schema, {
      [Q_NAME]: "Ada",
      removed_block_x: "stale answer",
    });
    const stale = rows.find((r: PairedAnswer) => r.blockId === "removed_block_x");
    expect(stale).toBeDefined();
    expect(stale!.isQuestion).toBe(false);
    expect(stale!.label).toBe(t("dashboard.inbox.questionFallback"));
    expect(stale!.answer).toBe("stale answer");
  });

  it("answers to non-question blocks render under the fallback label; non-strings never render", () => {
    const rows = pairAnswersWithBlocks(schema, {
      b_welcome: "stray welcome answer",
      [Q_NAME]: "Ada",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      weird_id: 42 as any,
    });
    // The stray welcome answer is defensively rendered under the fallback
    // label (the submit engine would never have stored it — it rejects
    // answers to non-question blocks), while the non-string value is not.
    expect(rows.map((r) => r.blockId).sort()).toEqual([
      "a0000000001",
      "a0000000002",
      "b_welcome",
    ]);
    const stray = rows.find((r) => r.blockId === "b_welcome");
    expect(stray!.isQuestion).toBe(false);
    expect(stray!.label).toBe(t("dashboard.inbox.questionFallback"));
  });

  it("the labels come from the PINNED version passed in — never a global 'current' schema", () => {
    const v2 = envelope([
      { id: Q_NAME, kind: "short_text", label: "Your full name", required: true },
      { id: Q_STORY, kind: "long_text", label: "Your story", required: false },
    ]);
    // Same answers object paired against v1 and v2 keeps DIFFERENT labels.
    const answers = { [Q_NAME]: "Ada" };
    expect(pairAnswersWithBlocks(schema, answers)[0]!.label).toBe("Your name");
    expect(pairAnswersWithBlocks(v2, answers)[0]!.label).toBe("Your full name");
  });
});

describe("inbox wiring (source contracts)", () => {
  it("the list page is a server component reading through the internal API", () => {
    const page = readWebSource(
      "src/app/dashboard/forms/[id]/inbox/page.tsx",
    );
    expect(page).toContain("getServerSession");
    expect(page).toContain("getForm");
    expect(page).toContain("notFound()");
    expect(page).toContain('listSubmissions(id, cursor)');
    // Pagination follows the API's opaque nextCursor.
    expect(page).toContain("page.nextCursor");
    expect(page).toContain("dashboard.inbox.nextPage");
    // Empty state + date + preview keys are catalog keys.
    expect(page).toContain("dashboard.inbox.empty");
    expect(page).toContain("dashboard.inbox.submittedAt");
    expect(page).toContain("dashboard.inbox.previewEmpty");
    expect(page).toContain("dashboard.inbox.formVersion");
  });

  it("the detail page pairs from the pinned schema and renders escaped plain text", () => {
    const page = readWebSource(
      "src/app/dashboard/forms/[id]/inbox/[submissionId]/page.tsx",
    );
    expect(page).toContain("pairAnswersWithBlocks");
    expect(page).toContain("detail.pinnedSchema");
    expect(page).toContain("detail.submission.answers");
    expect(page).toContain("dashboard.inbox.submittedAt");
    expect(page).toContain("dashboard.inbox.formVersion");
    expect(page).toContain("dashboard.inbox.notFound");
    // No raw-HTML escape hatch anywhere in the inbox (the doc comments
    // mention the guardrail by name; only real JSX usage would match).
    for (const source of inboxSources()) {
      expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
    }
  });

  it("readers parse through the shared contracts and forward the cookie", () => {
    const readers = readWebSource(
      "src/app/dashboard/forms/[id]/inbox/readers.ts",
    );
    expect(readers).toContain("listSubmissionsResponseSchema.safeParse");
    expect(readers).toContain("submissionDetailSchema.safeParse");
    expect(readers).toContain("internalApiUrl");
    expect(readers).toContain('cache: "no-store"');
    expect(readers).toContain("cookie");
  });

  it("the form page links to the per-form inbox", () => {
    const page = readWebSource("src/app/dashboard/forms/[id]/page.tsx");
    expect(page).toContain("/dashboard/forms/${form.id}/inbox");
    expect(page).toContain("dashboard.inbox.link");
  });
});

describe("inbox i18n keys", () => {
  const INBOX_KEYS = [
    "link",
    "title",
    "backToForm",
    "empty",
    "loadFailed",
    "notFound",
    "submittedAt",
    "formVersion",
    "submissionIdLabel",
    "answersHeading",
    "previewEmpty",
    "questionFallback",
    "noAnswer",
    "nextPage",
    "unknownAnswer",
  ] as const;

  it("every inbox key exists in the catalog with non-empty copy", () => {
    for (const key of INBOX_KEYS) {
      const value = t(`dashboard.inbox.${key}` as never);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("the date and version keys carry their placeholders", () => {
    expect(en.dashboard.inbox.submittedAt).toContain("{date}");
    expect(en.dashboard.inbox.formVersion).toContain("{version}");
    expect(t("dashboard.inbox.submittedAt", { date: "2026-10-31T12:00:00.000Z" })).toBe(
      "Received 2026-10-31T12:00:00.000Z",
    );
  });

  it("every t('dashboard.inbox.*') reference in the inbox pages resolves", () => {
    for (const source of inboxSources()) {
      const keys = [...source.matchAll(/dashboard\.inbox\.(\w+)/g)].map(
        (m) => m[1]!,
      );
      if (keys.length === 0) continue; // e.g. the pairing module
      for (const key of keys) {
        expect(INBOX_KEYS).toContain(key);
      }
    }
  });
});
