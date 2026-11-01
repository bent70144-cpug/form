import type { FormBlock, ProblemDetails } from "@form/contracts";

/**
 * Pure state helpers for the interactive public form (ticket 10). Extracted
 * from the client component so the SUBMISSION semantics are unit-testable
 * without a DOM: the server is authoritative (client validation is a
 * convenience only — spec), and every user-facing string is an i18n key.
 */

/** Which screen the form shows. */
export type PublicFormPhase = "form" | "ended" | "closed" | "expired" | "error";

/** Field errors keyed by block id (paths look like `answers.<blockId>`). */
export function mapFieldErrors(problem: ProblemDetails): Record<string, string> {
  const out: Record<string, string> = {};
  for (const error of problem.errors ?? []) {
    if (error.path.startsWith("answers.")) {
      const blockId = error.path.slice("answers.".length);
      if (blockId.length > 0 && out[blockId] === undefined) {
        out[blockId] = error.code;
      }
    }
  }
  return out;
}

/**
 * Maps a failed submit onto the next phase: a 422 keeps the form open with
 * per-field errors; closed/expired/problems get their dedicated screens.
 */
export function phaseForSubmitProblem(problem: ProblemDetails | null, status: number): PublicFormPhase {
  const code = problem?.code;
  if (code === "form_closed") return "closed";
  if (code === "session_expired" || code === "session_not_found" || code === "session_required") {
    return "expired";
  }
  if (status === 422 && code === "validation_failed") return "form";
  return "error";
}

/**
 * Client-side REQUIRED check (convenience only — the server re-validates):
 * whitespace-only text counts as empty, matching the engine's rule. Returns
 * the ids of required question blocks whose answer is missing/blank.
 */
export function blankRequiredBlocks(
  blocks: FormBlock[],
  answers: Record<string, string>,
): string[] {
  const missing: string[] = [];
  for (const block of blocks) {
    if (block.kind !== "short_text" && block.kind !== "long_text") continue;
    if (!block.required) continue;
    if ((answers[block.id] ?? "").trim() === "") missing.push(block.id);
  }
  return missing;
}

/** The form's ending block (validated last-if-present by the publisher). */
export function endingBlock(
  blocks: FormBlock[],
): Extract<FormBlock, { kind: "ending" }> | null {
  return blocks.find((b): b is Extract<FormBlock, { kind: "ending" }> => b.kind === "ending") ?? null;
}

/** The welcome block (validated first-if-present by the publisher). */
export function welcomeBlock(
  blocks: FormBlock[],
): Extract<FormBlock, { kind: "welcome" }> | null {
  return blocks.find((b): b is Extract<FormBlock, { kind: "welcome" }> => b.kind === "welcome") ?? null;
}
