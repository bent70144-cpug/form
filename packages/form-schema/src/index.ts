/**
 * Form schema envelope and the M0 block union (spec: "Form schema and
 * versioning"). Skeleton slice of ticket 01: stable envelope type, defaults and
 * `emptyDraft()`. Zod validation of the envelope arrives with the draft API
 * slice (ticket 07).
 */

export type BlockId = string;

export type Block =
  | { id: BlockId; kind: "welcome"; title: string; description?: string }
  | {
      id: BlockId;
      kind: "short_text";
      label: string;
      description?: string;
      required: boolean;
      placeholder?: string;
    }
  | {
      id: BlockId;
      kind: "long_text";
      label: string;
      description?: string;
      required: boolean;
      placeholder?: string;
    }
  | { id: BlockId; kind: "ending"; title: string; description?: string };

export type LogicRule = Record<string, unknown>; // M1/M2 introduces real rules
export type Theme = { preset: "default" };
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
