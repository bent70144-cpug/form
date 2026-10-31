import { describe, expect, it } from "vitest";
import {
  BLOCK_ID_RE,
  DESCRIPTION_MAX,
  DRAFT_JSON_MAX_BYTES,
  LABEL_MAX,
  LONG_TEXT_ANSWER_MAX,
  MAX_BLOCKS,
  NUL,
  PLACEHOLDER_MAX,
  SHORT_TEXT_ANSWER_MAX,
  SUBMISSION_JSON_MAX_BYTES,
  TITLE_MAX,
  emptyDraft,
  discardHiddenAnswers,
  isQuestion,
  isQuestionBlock,
  jsonByteLength,
  worstCaseSubmissionBytes,
  type Block,
  type FormSchema,
} from "../src/index";
import { endingBlock, longTextBlock, shortTextBlock, welcomeBlock } from "./factories";

describe("constants", () => {
  it("expose the exact contract values", () => {
    expect(TITLE_MAX).toBe(200);
    expect(LABEL_MAX).toBe(500);
    expect(DESCRIPTION_MAX).toBe(2000);
    expect(PLACEHOLDER_MAX).toBe(200);
    expect(MAX_BLOCKS).toBe(200);
    expect(DRAFT_JSON_MAX_BYTES).toBe(256 * 1024);
    expect(SUBMISSION_JSON_MAX_BYTES).toBe(100 * 1024);
    expect(SHORT_TEXT_ANSWER_MAX).toBe(1000);
    expect(LONG_TEXT_ANSWER_MAX).toBe(10000);
    expect(NUL).toBe("\u0000");
    expect(BLOCK_ID_RE.source).toBe("^[A-Za-z0-9_-]{10,32}$");
  });
});

describe("jsonByteLength", () => {
  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(jsonByteLength("")).toBe(2); // '""'
    expect(jsonByteLength("a")).toBe(3);
    expect(jsonByteLength("é")).toBe(4); // 1 char, 2 bytes
    expect(jsonByteLength("🎉")).toBe(6); // 2 UTF-16 units, 4 bytes
    expect(jsonByteLength({ a: 1 })).toBe(7); // '{"a":1}'
  });

  it("returns NaN for unserializable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonByteLength(cyclic)).toBeNaN();
    expect(jsonByteLength({ big: 1n })).toBeNaN();
  });
});

describe("isQuestionBlock / isQuestion", () => {
  it("treats only short_text and long_text as questions", () => {
    expect(isQuestionBlock("short_text")).toBe(true);
    expect(isQuestionBlock("long_text")).toBe(true);
    expect(isQuestionBlock("welcome")).toBe(false);
    expect(isQuestionBlock("ending")).toBe(false);
    expect(isQuestionBlock("statement")).toBe(false);
  });

  it("narrows blocks to question blocks", () => {
    const blocks: Block[] = [welcomeBlock(), shortTextBlock(), longTextBlock(), endingBlock()];
    const questions = blocks.filter(isQuestion);
    expect(questions.map((b) => b.kind)).toEqual(["short_text", "long_text"]);
    expect(questions.every((b) => "label" in b)).toBe(true);
  });
});

describe("discardHiddenAnswers (M0 structural no-op)", () => {
  it("returns the answers unchanged — M0 has no logic", () => {
    const schema: FormSchema = {
      ...emptyDraft(),
      blocks: [shortTextBlock(), longTextBlock()],
    };
    const answers = { [schema.blocks[0]!.id]: "x", [schema.blocks[1]!.id]: "y" };
    expect(discardHiddenAnswers(schema, answers)).toBe(answers);
  });
});

describe("worstCaseSubmissionBytes", () => {
  it("is envelope overhead plus each question kind's own cap", () => {
    const q1 = shortTextBlock();
    const q2 = longTextBlock();
    const schema: FormSchema = {
      ...emptyDraft(),
      title: "T",
      blocks: [welcomeBlock(), q1, q2, endingBlock()],
    };
    const expected =
      jsonByteLength({
        [q1.id]: "x".repeat(SHORT_TEXT_ANSWER_MAX),
        [q2.id]: "x".repeat(LONG_TEXT_ANSWER_MAX),
      }) + jsonByteLength(schema);
    expect(worstCaseSubmissionBytes(schema)).toBe(expected);
  });

  it("non-question blocks contribute nothing beyond the envelope", () => {
    const schema: FormSchema = {
      ...emptyDraft(),
      blocks: [welcomeBlock(), endingBlock()],
    };
    expect(worstCaseSubmissionBytes(schema)).toBe(jsonByteLength(schema));
  });

  it("exceeds the submission cap when 11 long questions are fully answered", () => {
    const schema: FormSchema = {
      ...emptyDraft(),
      blocks: Array.from({ length: 11 }, () => longTextBlock()),
    };
    expect(worstCaseSubmissionBytes(schema)).toBeGreaterThan(SUBMISSION_JSON_MAX_BYTES);
  });

  it("stays under the cap for one short question", () => {
    const schema: FormSchema = { ...emptyDraft(), blocks: [shortTextBlock()] };
    expect(worstCaseSubmissionBytes(schema)).toBeLessThan(SUBMISSION_JSON_MAX_BYTES);
  });
});
