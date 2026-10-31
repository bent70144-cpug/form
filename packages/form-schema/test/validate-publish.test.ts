import { describe, expect, it } from "vitest";
import { validatePublishSchema, type Block } from "../src/index";
import {
  codesOf,
  draftWith,
  endingBlock,
  longTextBlock,
  shortTextBlock,
  uid,
  welcomeBlock,
} from "./factories";

function codes(result: ReturnType<typeof validatePublishSchema>): string[] {
  return codesOf(result);
}

function at(result: ReturnType<typeof validatePublishSchema>, path: string): string[] {
  return result.ok ? [] : result.issues.filter((i) => i.path === path).map((i) => i.code);
}

describe("validatePublishSchema — valid publishes", () => {
  it("accepts welcome first, questions in the middle, ending last", () => {
    const result = validatePublishSchema(
      draftWith([welcomeBlock(), shortTextBlock(), longTextBlock(), endingBlock()]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts question-only forms (welcome/ending optional)", () => {
    expect(validatePublishSchema(draftWith([shortTextBlock()])).ok).toBe(true);
    expect(validatePublishSchema(draftWith([longTextBlock(), shortTextBlock()])).ok).toBe(true);
  });

  it("accepts welcome-only-question and question-ending halves", () => {
    expect(validatePublishSchema(draftWith([welcomeBlock(), longTextBlock()])).ok).toBe(true);
    expect(validatePublishSchema(draftWith([shortTextBlock(), endingBlock()])).ok).toBe(true);
  });
});

describe("validatePublishSchema — question requirement", () => {
  it("rejects an empty envelope with no_question_blocks", () => {
    const result = validatePublishSchema(draftWith([]));
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["no_question_blocks"]);
  });

  it("rejects welcome-only and ending-only drafts with no_question_blocks only", () => {
    // welcome is first (index 0) and ending is last (index 0), so ordering is
    // fine — only the question requirement fires.
    const welcomeOnly = validatePublishSchema(draftWith([welcomeBlock()]));
    expect(codes(welcomeOnly)).toEqual(["no_question_blocks"]);

    const endingOnly = validatePublishSchema(draftWith([endingBlock()]));
    expect(codes(endingOnly)).toEqual(["no_question_blocks"]);
  });

  it("rejects welcome+ending with no question", () => {
    const result = validatePublishSchema(draftWith([welcomeBlock(), endingBlock()]));
    expect(codes(result)).toEqual(["no_question_blocks"]);
  });
});

describe("validatePublishSchema — welcome/ending cardinality", () => {
  it("rejects two welcome blocks", () => {
    const result = validatePublishSchema(
      draftWith([welcomeBlock(), welcomeBlock(), shortTextBlock(), endingBlock()]),
    );
    expect(result.ok).toBe(false);
    expect(at(result, "blocks.1.kind")).toEqual(["multiple_welcome_blocks"]);
  });

  it("rejects two ending blocks", () => {
    const result = validatePublishSchema(
      draftWith([welcomeBlock(), shortTextBlock(), endingBlock(), endingBlock()]),
    );
    expect(at(result, "blocks.3.kind")).toEqual(["multiple_ending_blocks"]);
    expect(at(result, "blocks.2.kind")).toEqual([]);
  });

  it("reports cardinality and ordering violations together", () => {
    const result = validatePublishSchema(
      draftWith([welcomeBlock(), welcomeBlock(), shortTextBlock(), endingBlock(), endingBlock()]),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(["multiple_welcome_blocks", "multiple_ending_blocks"]),
    );
  });
});

describe("validatePublishSchema — ordering", () => {
  it("rejects a welcome that is not first", () => {
    const result = validatePublishSchema(
      draftWith([shortTextBlock(), welcomeBlock(), endingBlock()]),
    );
    expect(at(result, "blocks.1.kind")).toEqual(["welcome_not_first"]);
  });

  it("rejects an ending that is not last", () => {
    const result = validatePublishSchema(
      draftWith([welcomeBlock(), endingBlock(), shortTextBlock()]),
    );
    expect(at(result, "blocks.1.kind")).toEqual(["ending_not_last"]);
  });

  it("rejects both ordering violations at once", () => {
    const result = validatePublishSchema(
      draftWith([endingBlock(), shortTextBlock(), welcomeBlock()]),
    );
    expect(codes(result)).toEqual(expect.arrayContaining(["welcome_not_first", "ending_not_last"]));
  });
});

describe("validatePublishSchema — labels and titles", () => {
  it("rejects blank titles on welcome/ending and blank labels on questions", () => {
    const result = validatePublishSchema(
      draftWith([
        welcomeBlock({ title: "   " }),
        shortTextBlock({ label: "" }),
        longTextBlock({ label: " \t\n " }),
        endingBlock({ title: "" }),
      ]),
    );
    expect(at(result, "blocks.0.title")).toEqual(["empty_label"]);
    expect(at(result, "blocks.1.label")).toEqual(["empty_label"]);
    expect(at(result, "blocks.2.label")).toEqual(["empty_label"]);
    expect(at(result, "blocks.3.title")).toEqual(["empty_label"]);
  });

  it("accepts trimmed-non-empty titles and labels", () => {
    const result = validatePublishSchema(
      draftWith([
        welcomeBlock({ title: " hi " }),
        shortTextBlock({ label: " q " }),
        endingBlock({ title: "\u00a0bye\u00a0" }),
      ]),
    );
    // \u00a0 is not trimmed by String.prototype.trim? It is — NBSP is whitespace.
    expect(result.ok).toBe(true);
  });

  it("draft-time empty labels remain valid — publish-time only fires here", () => {
    // Covered by validate-draft.test.ts; this pins the distinction.
    const sparse = draftWith([
      { id: uid("w"), kind: "welcome", title: "" },
      { id: uid("q"), kind: "short_text", label: "", required: false },
    ]);
    expect(codes(validatePublishSchema(sparse))).toEqual(
      expect.arrayContaining(["empty_label", "empty_label"]),
    );
  });
});

describe("validatePublishSchema — propagates draft failures", () => {
  it("returns draft issues instead of publish issues", () => {
    const result = validatePublishSchema(
      draftWith([
        shortTextBlock({ id: "dup" }),
        shortTextBlock({ id: "dup" }),
        { id: uid(), kind: "date", label: "?" } as unknown as Block,
        endingBlock(),
      ]),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(["invalid_block_id", "duplicate_block_id", "unsupported_block_kind"]),
    );
    expect(codes(result)).not.toContain("no_question_blocks");
  });

  it("rejects unknown top-level fields at publish time too", () => {
    const result = validatePublishSchema({ ...draftWith([shortTextBlock()]), oops: 1 });
    expect(codes(result)).toEqual(["unknown_field"]);
  });
});
