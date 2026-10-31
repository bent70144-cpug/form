/**
 * Answer validation against a pinned published schema (spec submission step 4:
 * "Validate the answer object against the pinned schema"). Answers are a JSON
 * object keyed by block ID with string values in M0.
 *
 * Stable codes: `unknown_block_id`, `answer_to_non_question`,
 * `required_answer_missing`, `answer_too_long`, `invalid_character`,
 * `submission_too_large`, `invalid_answer_type`. Paths are the offending
 * answer keys; "" is the answers object itself.
 */
import { NUL, SUBMISSION_JSON_MAX_BYTES } from "./constants";
import { answerCharCap, discardHiddenAnswers, isQuestion, jsonByteLength } from "./helpers";
import type { FormSchema } from "./types";
import type { Issue, ValidationResult } from "./validate";

/**
 * Validate answers against a published schema. Missing keys count as missing
 * answers only for required questions; non-required questions may be absent or
 * empty. Hidden-block discard is applied first (a structural no-op in M0).
 */
export function validateAnswers(
  schema: FormSchema,
  answers: unknown,
): ValidationResult<Record<string, string>> {
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return { ok: false, issues: [{ path: "", code: "invalid_answer_type" }] };
  }

  const raw = answers as Record<string, unknown>;
  const issues: Issue[] = [];

  const bytes = jsonByteLength(raw);
  if (Number.isNaN(bytes)) {
    return { ok: false, issues: [{ path: "", code: "invalid_answer_type" }] };
  }
  if (bytes > SUBMISSION_JSON_MAX_BYTES) {
    issues.push({ path: "", code: "submission_too_large" });
  }

  const byId = new Map(schema.blocks.map((block) => [block.id, block]));

  for (const [key, value] of Object.entries(raw)) {
    const block = byId.get(key);
    if (block === undefined) {
      issues.push({ path: key, code: "unknown_block_id" });
      continue;
    }
    if (!isQuestion(block)) {
      issues.push({ path: key, code: "answer_to_non_question" });
      continue;
    }
    if (typeof value !== "string") {
      issues.push({ path: key, code: "invalid_answer_type" });
      continue;
    }

    if (block.required && value.trim() === "") {
      issues.push({ path: key, code: "required_answer_missing" });
    }
    if (value.length > answerCharCap(block.kind)) {
      issues.push({ path: key, code: "answer_too_long" });
    }
    if (value.includes(NUL)) {
      issues.push({ path: key, code: "invalid_character" });
    }
  }

  // Required questions must be answered even when their key is absent.
  for (const block of schema.blocks) {
    if (isQuestion(block) && block.required && !(block.id in raw)) {
      issues.push({ path: block.id, code: "required_answer_missing" });
    }
  }

  // M0: no logic engine, so every block is visible and the discard step is a
  // structural no-op (spec step 5). The hook stays in the success path so M1+
  // swaps the implementation exactly here, before anything is stored.
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: discardHiddenAnswers(schema, raw as Record<string, string>) };
}
