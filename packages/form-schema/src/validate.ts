/**
 * Draft and publish validation of the stable envelope.
 *
 * Every failure carries a stable error code from `ISSUE_CODES`; paths are
 * dot-joined segments from the envelope root ("" for the envelope itself, e.g.
 * `blocks.3.description`). Human-readable messages come from i18n keys keyed
 * off these codes at the API layer — the codes here are the contract.
 *
 * Draft validation is structural: empty labels/titles and zero question blocks
 * are valid drafts (publish-time strictness lives in `validatePublishSchema`).
 */
import {
  BLOCK_ID_RE,
  BLOCK_KINDS,
  DESCRIPTION_MAX,
  DRAFT_JSON_MAX_BYTES,
  LABEL_MAX,
  MAX_BLOCKS,
  NUL,
  PLACEHOLDER_MAX,
  TITLE_MAX,
} from "./constants";
import { isQuestionBlock, jsonByteLength } from "./helpers";
import { envelopeSchema } from "./schema";
import type { FormSchema } from "./types";
import type { z } from "zod";

export const ISSUE_CODES = [
  "unsupported_block_kind",
  "invalid_block_id",
  "duplicate_block_id",
  "title_too_long",
  "label_too_long",
  "description_too_long",
  "placeholder_too_long",
  "too_many_blocks",
  "schema_too_large",
  "invalid_character",
  "unknown_field",
  "invalid_type",
  "no_question_blocks",
  "multiple_welcome_blocks",
  "multiple_ending_blocks",
  "welcome_not_first",
  "ending_not_last",
  "empty_label",
  "unknown_block_id",
  "answer_to_non_question",
  "required_answer_missing",
  "answer_too_long",
  "submission_too_large",
  "invalid_answer_type",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

export interface Issue {
  /** Dot-joined path from the envelope root; "" is the envelope itself. */
  path: string;
  code: IssueCode;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

const BLOCK_KIND_SET = new Set<string>(BLOCK_KINDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Map zod structural issues onto stable codes. */
function mapZodIssues(issue: z.ZodIssue): Issue[] {
  if (issue.code === "unrecognized_keys") {
    // Unknown fields: zod reports the parent path plus a `keys` list — emit one
    // issue per offending key.
    return issue.keys.map((key) => ({
      path: [...issue.path, key].join("."),
      code: "unknown_field" as const,
    }));
  }
  const path = issue.path.join(".");
  const last = issue.path[issue.path.length - 1];
  switch (issue.code) {
    case "invalid_union_discriminator":
      return [{ path, code: "unsupported_block_kind" }];
    case "invalid_type":
    case "invalid_enum_value":
      return [{ path, code: last === "kind" ? "unsupported_block_kind" : "invalid_type" }];
    default:
      // invalid_literal (schemaVersion/theme preset), invalid_union, ...
      return [{ path, code: "invalid_type" }];
  }
}

/**
 * Semantic checks shared by draft and publish validation: character limits,
 * byte cap backstop is checked on the raw value, ID format, duplicates and NUL.
 */
function semanticIssues(draft: FormSchema): Issue[] {
  const issues: Issue[] = [];

  if (draft.title.length > TITLE_MAX) {
    issues.push({ path: "title", code: "title_too_long" });
  }
  if (draft.title.includes(NUL)) {
    issues.push({ path: "title", code: "invalid_character" });
  }
  if (draft.blocks.length > MAX_BLOCKS) {
    issues.push({ path: "blocks", code: "too_many_blocks" });
  }

  const seen = new Set<string>();
  draft.blocks.forEach((block, i) => {
    const at = (field: string): string => `blocks.${i}.${field}`;

    if (!BLOCK_ID_RE.test(block.id)) {
      issues.push({ path: at("id"), code: "invalid_block_id" });
    }
    if (seen.has(block.id)) {
      issues.push({ path: at("id"), code: "duplicate_block_id" });
    } else {
      seen.add(block.id);
    }

    if (block.kind === "welcome" || block.kind === "ending") {
      if (block.title.length > LABEL_MAX) {
        issues.push({ path: at("title"), code: "title_too_long" });
      }
      if (block.title.includes(NUL)) {
        issues.push({ path: at("title"), code: "invalid_character" });
      }
    } else {
      if (block.label.length > LABEL_MAX) {
        issues.push({ path: at("label"), code: "label_too_long" });
      }
      if (block.label.includes(NUL)) {
        issues.push({ path: at("label"), code: "invalid_character" });
      }
    }

    if (block.description !== undefined) {
      if (block.description.length > DESCRIPTION_MAX) {
        issues.push({ path: at("description"), code: "description_too_long" });
      }
      if (block.description.includes(NUL)) {
        issues.push({ path: at("description"), code: "invalid_character" });
      }
    }

    if (block.kind === "short_text" || block.kind === "long_text") {
      if (block.placeholder !== undefined) {
        if (block.placeholder.length > PLACEHOLDER_MAX) {
          issues.push({ path: at("placeholder"), code: "placeholder_too_long" });
        }
        if (block.placeholder.includes(NUL)) {
          issues.push({ path: at("placeholder"), code: "invalid_character" });
        }
      }
    }
  });

  return issues;
}

/**
 * Validate a draft envelope (draft-save strictness): structure, unknown fields,
 * supported kinds, ID format/uniqueness, character limits, NUL rejection,
 * block count and the 256 KB byte cap. Never enforces publish rules.
 */
export function validateDraftSchema(input: unknown): ValidationResult<FormSchema> {
  const issues: Issue[] = [];

  if (!isPlainObject(input) || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "", code: "invalid_type" }] };
  }

  const bytes = jsonByteLength(input);
  if (Number.isNaN(bytes)) {
    return { ok: false, issues: [{ path: "", code: "invalid_type" }] };
  }
  if (bytes > DRAFT_JSON_MAX_BYTES) {
    issues.push({ path: "", code: "schema_too_large" });
  }

  // Pre-scan so every kind problem yields one deterministic stable code at
  // `blocks.<i>.kind`, independent of zod's union fallbacks; replaced blocks
  // parse as inert placeholders so array indices stay stable.
  const working: Record<string, unknown> = { ...input };
  if (Array.isArray(input.blocks)) {
    const placeholder = (i: number): Record<string, unknown> => ({
      id: `__removed_${String(i).padStart(6, "0")}`,
      kind: "short_text",
      label: "",
      required: false,
    });
    working.blocks = (input.blocks as unknown[]).map((el, i) => {
      if (isPlainObject(el)) {
        if (!("kind" in el)) {
          issues.push({ path: `blocks.${i}.kind`, code: "invalid_type" });
          return placeholder(i);
        }
        if (typeof el.kind !== "string" || !BLOCK_KIND_SET.has(el.kind)) {
          issues.push({ path: `blocks.${i}.kind`, code: "unsupported_block_kind" });
          return placeholder(i);
        }
      }
      return el;
    });
  }

  const parsed = envelopeSchema.safeParse(working);
  if (!parsed.success) {
    for (const zodIssue of parsed.error.issues) issues.push(...mapZodIssues(zodIssue));
    return { ok: false, issues };
  }

  issues.push(...semanticIssues(parsed.data));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: parsed.data };
}

/** Publish-only structural rules (spec: "Form schema and versioning"). */
function publishIssues(draft: FormSchema): Issue[] {
  const issues: Issue[] = [];

  const welcomeIndexes: number[] = [];
  const endingIndexes: number[] = [];
  draft.blocks.forEach((block, i) => {
    if (block.kind === "welcome") welcomeIndexes.push(i);
    if (block.kind === "ending") endingIndexes.push(i);
  });

  if (!draft.blocks.some((block) => isQuestionBlock(block.kind))) {
    issues.push({ path: "blocks", code: "no_question_blocks" });
  }
  if (welcomeIndexes.length > 1) {
    issues.push({
      path: `blocks.${welcomeIndexes[1]}.kind`,
      code: "multiple_welcome_blocks",
    });
  }
  if (endingIndexes.length > 1) {
    issues.push({
      path: `blocks.${endingIndexes[1]}.kind`,
      code: "multiple_ending_blocks",
    });
  }
  if (welcomeIndexes.length > 0 && welcomeIndexes[0] !== 0) {
    issues.push({ path: `blocks.${welcomeIndexes[0]}.kind`, code: "welcome_not_first" });
  }
  const lastEnding = endingIndexes[endingIndexes.length - 1];
  if (endingIndexes.length > 0 && lastEnding !== draft.blocks.length - 1) {
    issues.push({ path: `blocks.${lastEnding}.kind`, code: "ending_not_last" });
  }

  draft.blocks.forEach((block, i) => {
    if (block.kind === "short_text" || block.kind === "long_text") {
      if (block.label.trim() === "") {
        issues.push({ path: `blocks.${i}.label`, code: "empty_label" });
      }
    } else if (block.title.trim() === "") {
      issues.push({ path: `blocks.${i}.title`, code: "empty_label" });
    }
  });

  return issues;
}

/**
 * Validate a schema at publish time: everything `validateDraftSchema` checks,
 * plus at least one question block, at most one welcome/ending block, welcome
 * first and ending last if present, and non-empty (trimmed) titles/labels.
 */
export function validatePublishSchema(input: unknown): ValidationResult<FormSchema> {
  const draft = validateDraftSchema(input);
  if (!draft.ok) return draft;
  const issues = publishIssues(draft.value);
  return issues.length > 0 ? { ok: false, issues } : draft;
}
