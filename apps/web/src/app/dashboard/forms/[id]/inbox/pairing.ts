import { t } from "@form/i18n";
import type { FormDraftSchema } from "@form/contracts";

/**
 * Answer/question pairing for the inbox detail page (ticket 11).
 *
 * The PINNED version's schema is the source of truth for labels: each
 * question block (M0: short_text / long_text) pairs with the answer stored
 * under its block id, in the form's own block order. Answers whose block id
 * does not match a question in the pinned schema (defensive — versions are
 * immutable, but never crash the review UI) are appended after the questions
 * with the i18n fallback label. Labels and answers are returned as PLAIN
 * strings: the page renders them as React text nodes, which escape HTML by
 * construction (no dangerouslySetInnerHTML anywhere in the inbox).
 */
export interface PairedAnswer {
  /** The block id the answer is stored under. */
  blockId: string;
  /** The question label FROM THE PINNED VERSION (fallback for unknown ids). */
  label: string;
  /** Whether the block was a required question in the pinned version. */
  required: boolean;
  /** True when the block matched a question block of the pinned schema. */
  isQuestion: boolean;
  /** The answer text, or null when the optional question was left out. */
  answer: string | null;
}

type PinnedBlock = FormDraftSchema["blocks"][number];

function isQuestionBlock(
  block: PinnedBlock,
): block is Extract<PinnedBlock, { kind: "short_text" | "long_text" }> {
  return block.kind === "short_text" || block.kind === "long_text";
}

export function pairAnswersWithBlocks(
  schema: FormDraftSchema,
  answers: Record<string, string>,
): PairedAnswer[] {
  const rows: PairedAnswer[] = [];
  const questionIds = new Set<string>();

  for (const block of schema.blocks) {
    if (!isQuestionBlock(block)) continue;
    questionIds.add(block.id);
    const raw = answers[block.id];
    rows.push({
      blockId: block.id,
      label: block.label,
      required: block.required,
      isQuestion: true,
      answer: typeof raw === "string" && raw.length > 0 ? raw : null,
    });
  }

  for (const [blockId, value] of Object.entries(answers)) {
    if (questionIds.has(blockId)) continue;
    // M0 answers are strings (server-validated); anything else is not
    // rendered as text.
    if (typeof value !== "string" || value.length === 0) continue;
    rows.push({
      blockId,
      label: t("dashboard.inbox.questionFallback"),
      required: false,
      isQuestion: false,
      answer: value,
    });
  }

  return rows;
}
