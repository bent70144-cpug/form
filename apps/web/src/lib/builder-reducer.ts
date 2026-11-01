/**
 * Pure builder reducer (ticket 08) over the draft envelope.
 *
 * The envelope's `schemaVersion`, `logic`, `theme` and `settings` pass through
 * untouched — the M0 builder only edits the envelope `title` (the
 * respondent-facing title, distinct from `forms.name`) and the block list.
 *
 * Block IDs are provided BY THE CALLER on `add_block` and are NEVER generated
 * here: update, move and remove keep every surviving block's id byte-for-byte
 * stable (pinned by test/builder-reducer.test.ts).
 */
import type { FormBlock, FormDraftSchema } from "@form/contracts";

export type BuilderBlockKind = FormBlock["kind"];

/** Per-kind editable fields; the reducer applies only what the kind supports. */
export interface BlockPatch {
  title?: string;
  label?: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
}

export type BuilderAction =
  | { type: "set_title"; title: string }
  | { type: "add_block"; id: string; kind: BuilderBlockKind }
  | { type: "update_block"; id: string; patch: BlockPatch }
  | { type: "move_block"; id: string; direction: "up" | "down" }
  | { type: "move_block_to"; id: string; index: number }
  | { type: "remove_block"; id: string };

/** Fresh block content for a new ID (drafts allow empty labels/titles). */
export function newBlock(id: string, kind: BuilderBlockKind): FormBlock {
  switch (kind) {
    case "welcome":
      return { id, kind, title: "" };
    case "ending":
      return { id, kind, title: "" };
    case "short_text":
      return { id, kind, label: "", required: false };
    case "long_text":
      return { id, kind, label: "", required: false };
  }
}

/** An empty optional string drops the key entirely (strict envelope stays clean). */
function optional(value: string): string | undefined {
  return value === "" ? undefined : value;
}

export function builderReducer(
  state: FormDraftSchema,
  action: BuilderAction,
): FormDraftSchema {
  switch (action.type) {
    case "set_title":
      return { ...state, title: action.title };

    case "add_block":
      // Append at the end; keyboard/drag reorder puts it where it belongs.
      return { ...state, blocks: [...state.blocks, newBlock(action.id, action.kind)] };

    case "update_block":
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.id === action.id ? applyPatch(block, action.patch) : block,
        ),
      };

    case "move_block": {
      const index = state.blocks.findIndex((b) => b.id === action.id);
      if (index < 0) return state;
      const target = action.direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= state.blocks.length) return state;
      return { ...state, blocks: swap(state.blocks, index, target) };
    }

    case "move_block_to": {
      const index = state.blocks.findIndex((b) => b.id === action.id);
      if (index < 0) return state;
      const target = Math.max(0, Math.min(state.blocks.length - 1, action.index));
      if (target === index) return state;
      return { ...state, blocks: moveTo(state.blocks, index, target) };
    }

    case "remove_block":
      return { ...state, blocks: state.blocks.filter((b) => b.id !== action.id) };
  }
}

function applyPatch(block: FormBlock, patch: BlockPatch): FormBlock {
  switch (block.kind) {
    case "welcome":
    case "ending": {
      const title = patch.title !== undefined ? patch.title : block.title;
      const description =
        patch.description !== undefined ? optional(patch.description) : block.description;
      return description === undefined
        ? { id: block.id, kind: block.kind, title }
        : { id: block.id, kind: block.kind, title, description };
    }
    case "short_text":
    case "long_text": {
      const label = patch.label !== undefined ? patch.label : block.label;
      const required = patch.required !== undefined ? patch.required : block.required;
      const description =
        patch.description !== undefined ? optional(patch.description) : block.description;
      const placeholder =
        patch.placeholder !== undefined ? optional(patch.placeholder) : block.placeholder;
      const base = { id: block.id, kind: block.kind, label, required };
      if (description === undefined && placeholder === undefined) return base;
      return {
        ...base,
        ...(description !== undefined ? { description } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
      };
    }
  }
}

function swap(blocks: FormBlock[], i: number, j: number): FormBlock[] {
  const next = [...blocks];
  const tmp = next[i]!;
  next[i] = next[j]!;
  next[j] = tmp;
  return next;
}

function moveTo(blocks: FormBlock[], from: number, to: number): FormBlock[] {
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
