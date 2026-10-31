/**
 * Runtime helpers shared by validation, the draft API and the renderer.
 * No Node/DOM-only APIs: byte counting uses the universal `TextEncoder`.
 */
import { LONG_TEXT_ANSWER_MAX, SHORT_TEXT_ANSWER_MAX } from "./constants";
import type { Block, FormSchema, QuestionBlock } from "./types";

/**
 * UTF-8 byte length of the JSON serialization of `value`.
 * Returns `NaN` when the value cannot be serialized (cycles, BigInt, ...).
 */
export function jsonByteLength(value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return Number.NaN;
  }
  return new TextEncoder().encode(json).byteLength;
}

/** Whether the block kind produces answers. */
export function isQuestionBlock(kind: string): boolean {
  return kind === "short_text" || kind === "long_text";
}

/** Type guard: whether this block produces answers. */
export function isQuestion(block: Block): block is QuestionBlock {
  return isQuestionBlock(block.kind);
}

/** Per-kind answer character cap. */
export function answerCharCap(kind: Block["kind"]): number {
  return kind === "short_text" ? SHORT_TEXT_ANSWER_MAX : LONG_TEXT_ANSWER_MAX;
}

/**
 * Publish-time worst-case submission size warning: the serialized envelope
 * overhead plus, for every question block, an answer at that kind's own
 * character cap (spec: "Publish warns when the worst-case answer size for a
 * form, using each question kind's own cap, would exceed the submission cap").
 */
export function worstCaseSubmissionBytes(schema: FormSchema): number {
  const worstAnswers: Record<string, string> = {};
  for (const block of schema.blocks) {
    if (!isQuestion(block)) continue;
    worstAnswers[block.id] = "x".repeat(answerCharCap(block.kind));
  }
  // A form without question blocks has no answer bytes at all; the empty
  // answers object is part of the fixed envelope overhead.
  const answersBytes = Object.keys(worstAnswers).length > 0 ? jsonByteLength(worstAnswers) : 0;
  return answersBytes + jsonByteLength(schema);
}

/**
 * Hidden-block discard hook (spec submission step 5: "Discard answers to
 * hidden blocks"). M0 has no logic, so visibility is structural and this is a
 * documented no-op that returns the answers unchanged. When the logic engine
 * arrives, this is the single point that re-evaluates visibility from the
 * pinned schema + raw answers and drops hidden blocks' values before
 * validation and storage.
 */
export function discardHiddenAnswers(
  _schema: FormSchema,
  answers: Record<string, string>,
): Record<string, string> {
  return answers;
}
