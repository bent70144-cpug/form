/**
 * Test factories. Block IDs are 10+ chars so they pass BLOCK_ID_RE unless a
 * test deliberately breaks the format.
 */
import { emptyDraft, type Block, type FormSchema } from "../src/index";

let counter = 0;

/** Unique 10-char ID like "q000000042". */
export function uid(prefix = "q"): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(9, "0")}`;
}

export function welcomeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: uid("w"),
    kind: "welcome",
    title: "Welcome",
    description: "Hello there",
    ...overrides,
  } as Block;
}

export function endingBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: uid("e"),
    kind: "ending",
    title: "Thanks!",
    description: "Bye",
    ...overrides,
  } as Block;
}

export function shortTextBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: uid("q"),
    kind: "short_text",
    label: "Short question",
    description: "Answer briefly",
    required: false,
    placeholder: "Type here",
    ...overrides,
  } as Block;
}

export function longTextBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: uid("q"),
    kind: "long_text",
    label: "Long question",
    description: "Answer at length",
    required: false,
    placeholder: "Write away",
    ...overrides,
  } as Block;
}

/** A draft envelope with the given blocks; publish-valid when ordered well. */
export function draftWith(blocks: Block[], overrides: Partial<FormSchema> = {}): FormSchema {
  return { ...emptyDraft(), title: "Form title", blocks, ...overrides };
}

/** The canonical publish-valid draft: welcome, questions, ending. */
export function publishableDraft(): FormSchema {
  return draftWith([welcomeBlock(), shortTextBlock(), longTextBlock(), endingBlock()]);
}

export function codesOf(result: { ok: boolean; issues?: { code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

export function issuesAt(
  result: { ok: boolean; issues?: { path: string; code: string }[] },
  path: string,
): string[] {
  return (result.issues ?? []).filter((issue) => issue.path === path).map((issue) => issue.code);
}
