import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_THEME, emptyDraft, validateDraftSchema } from "../src/index";

const EMPTY_DRAFT_JSON =
  '{"schemaVersion":1,"title":"","blocks":[],"logic":[],"theme":{"preset":"default"},"settings":{}}';

describe("emptyDraft()", () => {
  it("is exactly the specified empty envelope (JSON.stringify deep equality)", () => {
    expect(JSON.stringify(emptyDraft())).toBe(EMPTY_DRAFT_JSON);
    expect(emptyDraft()).toEqual({
      schemaVersion: 1,
      title: "",
      blocks: [],
      logic: [],
      theme: { preset: "default" },
      settings: {},
    });
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = emptyDraft();
    a.blocks.push({ id: "b1", kind: "welcome", title: "Hi" });
    a.title = "changed";
    const b = emptyDraft();
    expect(b.blocks).toEqual([]);
    expect(b.title).toBe("");
    expect(b.theme).toEqual(DEFAULT_THEME);
    expect(b.settings).toEqual(DEFAULT_SETTINGS);
    expect(JSON.stringify(b)).toBe(EMPTY_DRAFT_JSON);
  });

  it("exports the documented default theme and settings", () => {
    expect(DEFAULT_THEME).toEqual({ preset: "default" });
    expect(DEFAULT_SETTINGS).toEqual({});
  });

  it("the empty draft passes draft validation", () => {
    const result = validateDraftSchema(emptyDraft());
    expect(result.ok).toBe(true);
  });
});
