/**
 * Form schema envelope and the M0 block union (spec: "Form schema and
 * versioning"). The envelope is stable: statement, choice, date, file and other
 * block kinds are added later without changing it.
 */

export type BlockId = string;

export type BlockKind = "welcome" | "short_text" | "long_text" | "ending";

/** Blocks that produce answers (only question blocks do). */
export type QuestionKind = Extract<BlockKind, "short_text" | "long_text">;

export interface WelcomeBlock {
  id: BlockId;
  kind: "welcome";
  title: string;
  description?: string;
}

export interface ShortTextBlock {
  id: BlockId;
  kind: "short_text";
  label: string;
  description?: string;
  required: boolean;
  placeholder?: string;
}

export interface LongTextBlock {
  id: BlockId;
  kind: "long_text";
  label: string;
  description?: string;
  required: boolean;
  placeholder?: string;
}

export interface EndingBlock {
  id: BlockId;
  kind: "ending";
  title: string;
  description?: string;
}

export type Block = WelcomeBlock | ShortTextBlock | LongTextBlock | EndingBlock;

/** A question block, i.e. a block that produces answers. */
export type QuestionBlock = ShortTextBlock | LongTextBlock;

/** M0 has no logic; rules arrive in M1/M2 without changing the envelope. */
export type LogicRule = Record<string, unknown>;

/** Default preset in M0; future presets extend this without breaking it. */
export type Theme = { preset: "default" };

/**
 * Free-form settings bag. The envelope reserves settings and the renderer
 * ignores them in M0 (e.g. a future password gate), so this stays permissive.
 */
export type FormSettings = Record<string, unknown>;

/** The stable form envelope. */
export interface FormSchema {
  schemaVersion: 1;
  title: string;
  blocks: Block[];
  logic: LogicRule[];
  theme: Theme;
  settings: FormSettings;
}

export const DEFAULT_THEME: Theme = { preset: "default" };
export const DEFAULT_SETTINGS: FormSettings = {};

/**
 * The empty draft is exactly:
 * `{ schemaVersion: 1, title: "", blocks: [], logic: [], theme: { preset: "default" }, settings: {} }`
 */
export function emptyDraft(): FormSchema {
  return {
    schemaVersion: 1,
    title: "",
    blocks: [],
    logic: [],
    theme: { ...DEFAULT_THEME },
    settings: {},
  };
}
