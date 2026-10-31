import { describe, expect, it } from "vitest";
import {
  BLOCK_ID_RE,
  DESCRIPTION_MAX,
  DRAFT_JSON_MAX_BYTES,
  LABEL_MAX,
  PLACEHOLDER_MAX,
  TITLE_MAX,
  emptyDraft,
  jsonByteLength,
  validateDraftSchema,
  type Block,
  type FormSchema,
  type Issue,
} from "../src/index";
import {
  codesOf,
  draftWith,
  endingBlock,
  longTextBlock,
  publishableDraft,
  shortTextBlock,
  uid,
  welcomeBlock,
} from "./factories";

function codes(result: ReturnType<typeof validateDraftSchema>): string[] {
  return codesOf(result);
}

function at(result: ReturnType<typeof validateDraftSchema>, path: string): string[] {
  return result.ok
    ? []
    : result.issues.filter((issue: Issue) => issue.path === path).map((i) => i.code);
}

describe("validateDraftSchema — valid drafts", () => {
  it("accepts a fully populated draft and returns the parsed value", () => {
    const draft = publishableDraft();
    const result = validateDraftSchema(draft);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(draft);
  });

  it("accepts structurally valid drafts with empty labels/titles and zero questions", () => {
    expect(validateDraftSchema(emptyDraft()).ok).toBe(true);
    const sparse = draftWith([
      { id: uid("w"), kind: "welcome", title: "" },
      shortTextBlock({ label: "", required: false, placeholder: undefined }),
      { id: uid("e"), kind: "ending", title: "" },
    ]);
    expect(validateDraftSchema(sparse).ok).toBe(true);
  });

  it("accepts exactly-at-limit text fields", () => {
    const draft = draftWith([
      shortTextBlock({
        label: "a".repeat(LABEL_MAX),
        description: "b".repeat(DESCRIPTION_MAX),
        placeholder: "c".repeat(PLACEHOLDER_MAX),
      }),
      endingBlock({ title: "d".repeat(LABEL_MAX) }),
    ]);
    draft.title = "e".repeat(TITLE_MAX);
    expect(validateDraftSchema(draft).ok).toBe(true);
  });
});

describe("validateDraftSchema — envelope shape", () => {
  it("rejects non-objects with invalid_type", () => {
    for (const bad of [null, 42, "x", [], true, undefined]) {
      const result = validateDraftSchema(bad);
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(["invalid_type"]);
    }
  });

  it("rejects unknown top-level fields with unknown_field", () => {
    const result = validateDraftSchema({ ...emptyDraft(), extra: true });
    expect(result.ok).toBe(false);
    expect(at(result, "extra")).toEqual(["unknown_field"]);
  });

  it("rejects a wrong schemaVersion with invalid_type", () => {
    const result = validateDraftSchema({ ...emptyDraft(), schemaVersion: 2 });
    expect(result.ok).toBe(false);
    expect(at(result, "schemaVersion")).toEqual(["invalid_type"]);
  });

  it("rejects wrong field types with invalid_type (missing label, bad required)", () => {
    const result = validateDraftSchema({
      ...emptyDraft(),
      blocks: [{ id: uid(), kind: "short_text", required: "yes" }],
    });
    expect(result.ok).toBe(false);
    expect(at(result, "blocks.0.label")).toEqual(["invalid_type"]);
    expect(at(result, "blocks.0.required")).toEqual(["invalid_type"]);
  });

  it("rejects non-string values in answers-shaped settings bags? no — settings stay permissive", () => {
    const result = validateDraftSchema({
      ...emptyDraft(),
      settings: { notify: true, nested: { anything: [1, 2] } },
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateDraftSchema — block kinds", () => {
  it("rejects unsupported kinds with unsupported_block_kind", () => {
    const result = validateDraftSchema({
      ...emptyDraft(),
      blocks: [{ id: uid(), kind: "paragraph", title: "Nope" }],
    });
    expect(result.ok).toBe(false);
    expect(at(result, "blocks.0.kind")).toEqual(["unsupported_block_kind"]);
  });

  it("reports the original index for unsupported kinds among valid blocks", () => {
    const result = validateDraftSchema({
      ...emptyDraft(),
      blocks: [shortTextBlock(), { id: uid(), kind: "choice", label: "?" }, shortTextBlock()],
    });
    expect(result.ok).toBe(false);
    expect(at(result, "blocks.1.kind")).toEqual(["unsupported_block_kind"]);
  });

  it("reports missing and non-string kinds deterministically", () => {
    const missing = validateDraftSchema({
      ...emptyDraft(),
      blocks: [{ id: uid(), title: "No kind" }],
    });
    expect(at(missing, "blocks.0.kind")).toEqual(["invalid_type"]);

    const numeric = validateDraftSchema({
      ...emptyDraft(),
      blocks: [{ id: uid(), kind: 7, title: "x" }],
    });
    expect(at(numeric, "blocks.0.kind")).toEqual(["unsupported_block_kind"]);
  });

  it("rejects unknown fields inside blocks with unknown_field", () => {
    const result = validateDraftSchema({
      ...emptyDraft(),
      blocks: [{ ...shortTextBlock(), options: ["a"] }],
    });
    expect(result.ok).toBe(false);
    expect(at(result, "blocks.0.options")).toEqual(["unknown_field"]);
  });
});

describe("validateDraftSchema — block IDs", () => {
  it("enforces the ID regex boundaries", () => {
    expect(BLOCK_ID_RE.test("a".repeat(10))).toBe(true);
    expect(BLOCK_ID_RE.test("a".repeat(32))).toBe(true);
    expect(BLOCK_ID_RE.test("a".repeat(9))).toBe(false);
    expect(BLOCK_ID_RE.test("a".repeat(33))).toBe(false);

    const tooShort = validateDraftSchema({
      ...emptyDraft(),
      blocks: [{ id: "abc", kind: "ending", title: "t" }],
    });
    expect(at(tooShort, "blocks.0.id")).toEqual(["invalid_block_id"]);

    const tooLong = validateDraftSchema({
      ...emptyDraft(),
      blocks: [{ id: "a".repeat(33), kind: "ending", title: "t" }],
    });
    expect(at(tooLong, "blocks.0.id")).toEqual(["invalid_block_id"]);

    const badChars = validateDraftSchema({
      ...emptyDraft(),
      blocks: [{ id: "has space!!", kind: "ending", title: "t" }],
    });
    expect(at(badChars, "blocks.0.id")).toEqual(["invalid_block_id"]);

    const okIds = validateDraftSchema({
      ...emptyDraft(),
      blocks: [
        { id: "a-b_c9xZ_-", kind: "ending", title: "t" },
        { id: "A_-09azAZ__", kind: "welcome", title: "w" },
      ],
    });
    expect(okIds.ok).toBe(true);
  });

  it("rejects duplicate IDs with duplicate_block_id at later occurrences", () => {
    const id = uid();
    const result = validateDraftSchema(
      draftWith([shortTextBlock({ id }), longTextBlock({ id }), shortTextBlock({ id })]),
    );
    expect(result.ok).toBe(false);
    expect(at(result, "blocks.1.id")).toEqual(["duplicate_block_id"]);
    expect(at(result, "blocks.2.id")).toEqual(["duplicate_block_id"]);
    expect(at(result, "blocks.0.id")).toEqual([]);
  });
});

describe("validateDraftSchema — character limits", () => {
  it("rejects title over 200 characters", () => {
    const result = validateDraftSchema({ ...emptyDraft(), title: "x".repeat(TITLE_MAX + 1) });
    expect(at(result, "title")).toEqual(["title_too_long"]);
  });

  it("rejects labels and block titles over 500 characters", () => {
    const result = validateDraftSchema(
      draftWith([
        shortTextBlock({ label: "x".repeat(LABEL_MAX + 1) }),
        welcomeBlock({ title: "y".repeat(LABEL_MAX + 1) }),
        endingBlock({ title: "z".repeat(LABEL_MAX + 1) }),
      ]),
    );
    expect(at(result, "blocks.0.label")).toEqual(["label_too_long"]);
    expect(at(result, "blocks.1.title")).toEqual(["title_too_long"]);
    expect(at(result, "blocks.2.title")).toEqual(["title_too_long"]);
  });

  it("rejects descriptions over 2000 and placeholders over 200 characters", () => {
    const result = validateDraftSchema(
      draftWith([
        longTextBlock({
          description: "d".repeat(DESCRIPTION_MAX + 1),
          placeholder: "p".repeat(PLACEHOLDER_MAX + 1),
        }),
      ]),
    );
    expect(at(result, "blocks.0.description")).toEqual(["description_too_long"]);
    expect(at(result, "blocks.0.placeholder")).toEqual(["placeholder_too_long"]);
  });
});

describe("validateDraftSchema — NUL characters", () => {
  it("rejects NUL in every text field with invalid_character", () => {
    const draft: FormSchema = {
      ...emptyDraft(),
      title: "bad\u0000title",
      blocks: [
        welcomeBlock({ title: "w\u0000", description: "d\u0000" }),
        shortTextBlock({ label: "l\u0000", description: "d\u0000", placeholder: "p\u0000" }),
        longTextBlock({ description: "\u0000" }),
        endingBlock({ title: "\u0000end" }),
      ],
    };
    const result = validateDraftSchema(draft);
    expect(result.ok).toBe(false);
    expect(at(result, "title")).toEqual(["invalid_character"]);
    expect(at(result, "blocks.0.title")).toEqual(["invalid_character"]);
    expect(at(result, "blocks.0.description")).toEqual(["invalid_character"]);
    expect(at(result, "blocks.1.label")).toEqual(["invalid_character"]);
    expect(at(result, "blocks.1.description")).toEqual(["invalid_character"]);
    expect(at(result, "blocks.1.placeholder")).toEqual(["invalid_character"]);
    expect(at(result, "blocks.2.description")).toEqual(["invalid_character"]);
    expect(at(result, "blocks.3.title")).toEqual(["invalid_character"]);
  });
});

describe("validateDraftSchema — block count", () => {
  const many = (n: number): Block[] =>
    Array.from({ length: n }, (_, i) =>
      i === 0 ? welcomeBlock() : i === n - 1 ? endingBlock() : shortTextBlock(),
    );

  it("accepts 199 and 200 blocks", () => {
    expect(validateDraftSchema(draftWith(many(199))).ok).toBe(true);
    expect(validateDraftSchema(draftWith(many(200))).ok).toBe(true);
  });

  it("rejects 201 blocks with too_many_blocks", () => {
    const result = validateDraftSchema(draftWith(many(201)));
    expect(at(result, "blocks")).toEqual(["too_many_blocks"]);
    expect(codes(result)).toEqual(["too_many_blocks"]);
  });
});

describe("validateDraftSchema — byte caps", () => {
  const probe = { ...emptyDraft(), settings: { blob: "" } };
  const overhead = new TextEncoder().encode(JSON.stringify(probe)).byteLength; // includes "blob":""
  const pad = DRAFT_JSON_MAX_BYTES - overhead; // ASCII chars to add

  it("accepts a schema of exactly 256 KB (ASCII counted as bytes)", () => {
    const exact: FormSchema = { ...emptyDraft(), settings: { blob: "a".repeat(pad) } };
    expect(jsonByteLength(exact)).toBe(DRAFT_JSON_MAX_BYTES);
    const result = validateDraftSchema(exact);
    expect(result.ok).toBe(true);
  });

  it("rejects a schema one byte over the cap with schema_too_large", () => {
    const over: FormSchema = { ...emptyDraft(), settings: { blob: "a".repeat(pad + 1) } };
    const result = validateDraftSchema(over);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["schema_too_large"]);
  });

  it("counts multi-byte characters by BYTES, not characters (emoji)", () => {
    // 70,000 emoji = 280,000 bytes > 262,144 — yet only 70,000 "characters",
    // and settings are permissive, so nothing else can flag it.
    const emojiDraft: FormSchema = { ...emptyDraft(), settings: { blob: "🎉".repeat(70_000) } };
    expect(jsonByteLength(emojiDraft)).toBeGreaterThan(DRAFT_JSON_MAX_BYTES);
    const result = validateDraftSchema(emojiDraft);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["schema_too_large"]);
  });

  it("still reports schema_too_large together with other issues", () => {
    const draft: FormSchema = { ...emptyDraft(), title: "t".repeat(TITLE_MAX + 1) };
    (draft.settings as Record<string, unknown>).blob = "🎉".repeat(70_000);
    const result = validateDraftSchema(draft);
    expect(codes(result)).toEqual(expect.arrayContaining(["schema_too_large", "title_too_long"]));
  });
});

describe("validateDraftSchema — collects multiple issues", () => {
  it("reports every distinct problem in one pass", () => {
    const result = validateDraftSchema({
      ...emptyDraft(),
      title: "\u0000".repeat(TITLE_MAX + 1),
      blocks: [
        shortTextBlock({ id: "dup" }),
        shortTextBlock({ id: "dup" }),
        { id: uid(), kind: "date", label: "?" },
      ],
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "invalid_character",
        "title_too_long",
        "invalid_block_id",
        "duplicate_block_id",
        "unsupported_block_kind",
      ]),
    );
  });
});
