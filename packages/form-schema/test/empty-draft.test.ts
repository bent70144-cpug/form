import { describe, expect, it } from "vitest";
import { emptyDraft, DEFAULT_THEME } from "../src/index";

describe("form-schema (skeleton)", () => {
  it("emptyDraft() exports exactly the specified empty envelope", () => {
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
    a.theme.preset = "default";
    const b = emptyDraft();
    expect(b.blocks).toEqual([]);
    expect(b.theme).toEqual(DEFAULT_THEME);
  });
});
