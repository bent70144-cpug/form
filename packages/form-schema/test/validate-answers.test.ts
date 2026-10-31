import { describe, expect, it } from "vitest";
import {
  SHORT_TEXT_ANSWER_MAX,
  LONG_TEXT_ANSWER_MAX,
  SUBMISSION_JSON_MAX_BYTES,
  emptyDraft,
  jsonByteLength,
  validateAnswers,
  type Block,
  type FormSchema,
} from "../src/index";
import { endingBlock, longTextBlock, shortTextBlock, welcomeBlock } from "./factories";

/** Welcome + required short + optional long + ending. */
function fixtureSchema(): { schema: FormSchema; q1: string; q2: string; w: string; e: string } {
  const w = welcomeBlock();
  const q1 = shortTextBlock({ required: true });
  const q2 = longTextBlock({ required: false });
  const e = endingBlock();
  return {
    schema: { ...emptyDraft(), title: "T", blocks: [w, q1, q2, e] },
    w: w.id,
    q1: q1.id,
    q2: q2.id,
    e: e.id,
  };
}

function codes(result: ReturnType<typeof validateAnswers>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function at(result: ReturnType<typeof validateAnswers>, path: string): string[] {
  return result.ok ? [] : result.issues.filter((i) => i.path === path).map((i) => i.code);
}

describe("validateAnswers — valid submissions", () => {
  it("accepts answers for question blocks only", () => {
    const { schema, q1, q2 } = fixtureSchema();
    const result = validateAnswers(schema, {
      [q1]: "hello",
      [q2]: "a".repeat(LONG_TEXT_ANSWER_MAX),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ [q1]: "hello", [q2]: "a".repeat(10_000) });
  });

  it("accepts omitting non-required questions", () => {
    const { schema, q1 } = fixtureSchema();
    expect(validateAnswers(schema, { [q1]: "x" }).ok).toBe(true);
  });

  it("accepts empty and whitespace answers for non-required questions", () => {
    const { schema, q1, q2 } = fixtureSchema();
    expect(validateAnswers(schema, { [q1]: "x", [q2]: "" }).ok).toBe(true);
    expect(validateAnswers(schema, { [q1]: "x", [q2]: "  " }).ok).toBe(true);
  });
});

describe("validateAnswers — key checks", () => {
  it("rejects unknown/extra keys with unknown_block_id", () => {
    const { schema, q1 } = fixtureSchema();
    const result = validateAnswers(schema, { [q1]: "ok", nope: "x", also_nope: "y" });
    expect(result.ok).toBe(false);
    expect(at(result, "nope")).toEqual(["unknown_block_id"]);
    expect(at(result, "also_nope")).toEqual(["unknown_block_id"]);
  });

  it("rejects answers to welcome and ending blocks with answer_to_non_question", () => {
    const { schema, w, e, q1 } = fixtureSchema();
    const result = validateAnswers(schema, { [w]: "hi", [e]: "bye", [q1]: "x" });
    expect(at(result, w)).toEqual(["answer_to_non_question"]);
    expect(at(result, e)).toEqual(["answer_to_non_question"]);
    expect(at(result, q1)).toEqual([]);
  });
});

describe("validateAnswers — required", () => {
  it("rejects a missing key for a required question", () => {
    const { schema, q1, q2 } = fixtureSchema();
    const result = validateAnswers(schema, { [q2]: "here" });
    expect(at(result, q1)).toEqual(["required_answer_missing"]);
    expect(at(result, q2)).toEqual([]);
  });

  it("rejects whitespace-only answers to required questions", () => {
    const { schema, q1 } = fixtureSchema();
    for (const ws of ["", " ", "\t\n\r   "]) {
      const result = validateAnswers(schema, { [q1]: ws });
      expect(at(result, q1)).toEqual(["required_answer_missing"]);
    }
  });

  it("treats a non-string value for a required question as invalid_answer_type", () => {
    const { schema, q1 } = fixtureSchema();
    const result = validateAnswers(schema, { [q1]: 42 });
    expect(at(result, q1)).toEqual(["invalid_answer_type"]);
  });
});

describe("validateAnswers — lengths", () => {
  it("enforces the short-text 1000-character boundary", () => {
    const { schema, q1 } = fixtureSchema();
    expect(validateAnswers(schema, { [q1]: "a".repeat(SHORT_TEXT_ANSWER_MAX) }).ok).toBe(true);
    const over = validateAnswers(schema, { [q1]: "a".repeat(SHORT_TEXT_ANSWER_MAX + 1) });
    expect(at(over, q1)).toEqual(["answer_too_long"]);
  });

  it("enforces the long-text 10000-character boundary", () => {
    const { schema, q1, q2 } = fixtureSchema();
    expect(validateAnswers(schema, { [q1]: "ok", [q2]: "b".repeat(LONG_TEXT_ANSWER_MAX) }).ok).toBe(
      true,
    );
    const over = validateAnswers(schema, {
      [q1]: "ok",
      [q2]: "b".repeat(LONG_TEXT_ANSWER_MAX + 1),
    });
    expect(at(over, q2)).toEqual(["answer_too_long"]);
  });
});

describe("validateAnswers — characters and types", () => {
  it("rejects NUL with invalid_character", () => {
    const { schema, q1, q2 } = fixtureSchema();
    const result = validateAnswers(schema, { [q1]: "a\u0000b", [q2]: "\u0000" });
    expect(at(result, q1)).toEqual(["invalid_character"]);
    expect(at(result, q2)).toEqual(["invalid_character"]);
  });

  it("rejects non-string values with invalid_answer_type", () => {
    const { schema, q1, q2 } = fixtureSchema();
    const result = validateAnswers(schema, { [q1]: 42, [q2]: null });
    expect(at(result, q1)).toEqual(["invalid_answer_type"]);
    expect(at(result, q2)).toEqual(["invalid_answer_type"]);
  });

  it("rejects answers that are not plain objects", () => {
    const { schema } = fixtureSchema();
    for (const bad of [null, [], "x", 42, true]) {
      const result = validateAnswers(schema, bad);
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(["invalid_answer_type"]);
    }
  });
});

describe("validateAnswers — submission byte cap", () => {
  it("accepts 10 fully-answered long questions (just under 100 KB)", () => {
    const blocks: Block[] = Array.from({ length: 10 }, () => longTextBlock({ required: false }));
    const schema: FormSchema = { ...emptyDraft(), title: "T", blocks };
    const answers: Record<string, string> = {};
    for (const b of blocks) answers[b.id] = "a".repeat(LONG_TEXT_ANSWER_MAX);
    expect(jsonByteLength(answers)).toBeLessThan(SUBMISSION_JSON_MAX_BYTES);
    expect(validateAnswers(schema, answers).ok).toBe(true);
  });

  it("rejects 11 fully-answered long questions with submission_too_large", () => {
    const blocks: Block[] = Array.from({ length: 11 }, () => longTextBlock({ required: false }));
    const schema: FormSchema = { ...emptyDraft(), title: "T", blocks };
    const answers: Record<string, string> = {};
    for (const b of blocks) answers[b.id] = "a".repeat(LONG_TEXT_ANSWER_MAX);
    const result = validateAnswers(schema, answers);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["submission_too_large"]);
  });

  it("counts emoji answers by BYTES (12 × 5,000 emoji = 10k chars ≈ 240 KB)", () => {
    const blocks: Block[] = Array.from({ length: 12 }, () => longTextBlock({ required: false }));
    const schema: FormSchema = { ...emptyDraft(), title: "T", blocks };
    const answers: Record<string, string> = {};
    // 5,000 emoji = 10,000 UTF-16 units (exactly at the char cap) but 20,000
    // UTF-8 bytes each — the cap counts bytes, not characters.
    for (const b of blocks) answers[b.id] = "🎉".repeat(5000);
    const result = validateAnswers(schema, answers);
    // Every answer is exactly at its char cap; only the byte cap fires.
    expect(codes(result)).toEqual(["submission_too_large"]);
  });

  it("rejects unserializable answers (cycles) as invalid_answer_type", () => {
    const { schema } = fixtureSchema();
    const answers: Record<string, unknown> = {};
    (answers as { self?: unknown }).self = answers;
    const result = validateAnswers(schema, answers);
    expect(codes(result)).toEqual(["invalid_answer_type"]);
  });
});

describe("validateAnswers — multiple issues", () => {
  it("collects everything wrong in one pass", () => {
    const { schema, q1, q2, w } = fixtureSchema();
    const result = validateAnswers(schema, {
      [q1]: "   ",
      [q2]: "x".repeat(LONG_TEXT_ANSWER_MAX + 1) + "\u0000",
      [w]: "hi",
      ghost: 1,
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "required_answer_missing",
        "answer_too_long",
        "invalid_character",
        "answer_to_non_question",
        "unknown_block_id",
      ]),
    );
  });

  it("ignores __proto__-style keys as unknown block ids", () => {
    const { schema, q1 } = fixtureSchema();
    const answers = JSON.parse(`{"${q1}":"ok","__proto__":"bad"}`) as Record<string, string>;
    const result = validateAnswers(schema, answers);
    expect(at(result, "__proto__")).toEqual(["unknown_block_id"]);
  });
});
