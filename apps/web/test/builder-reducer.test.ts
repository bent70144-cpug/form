import { describe, expect, it } from "vitest";
import type { FormBlock, FormDraftSchema } from "@form/contracts";
import {
  builderReducer,
  newBlock,
  type BuilderAction,
} from "../src/lib/builder-reducer";

/**
 * Ticket 08 — the pure builder reducer.
 *
 * The critical pin: block IDs are provided by the caller on add and are
 * NEVER regenerated — edit, reorder (buttons or drag) and delete keep every
 * surviving block's id byte-for-byte stable, so a saved draft's answer
 * mapping survives builder shuffling.
 */

function draft(blocks: FormBlock[] = [], title = ""): FormDraftSchema {
  return {
    schemaVersion: 1,
    title,
    blocks,
    logic: [],
    theme: { preset: "default" },
    settings: {},
  };
}

const WELCOME = newBlock("welcome01", "welcome");
const SHORT = newBlock("shorttext01", "short_text");
const LONG = newBlock("longtext01", "long_text");
const ENDING = newBlock("ending01", "ending");

describe("builderReducer — add", () => {
  it("appends a block with the CALLER-provided id and the kind's default shape", () => {
    const next = builderReducer(draft(), { type: "add_block", id: "b1", kind: "welcome" });
    expect(next.blocks).toEqual([{ id: "b1", kind: "welcome", title: "" }]);

    const question = builderReducer(draft(), { type: "add_block", id: "b2", kind: "short_text" });
    expect(question.blocks).toEqual([{ id: "b2", kind: "short_text", label: "", required: false }]);

    const ending = builderReducer(draft(), { type: "add_block", id: "b3", kind: "ending" });
    expect(ending.blocks).toEqual([{ id: "b3", kind: "ending", title: "" }]);
  });

  it("never invents or mutates existing ids on add", () => {
    const state = draft([WELCOME, SHORT]);
    const next = builderReducer(state, { type: "add_block", id: "newid00001", kind: "long_text" });
    expect(next.blocks.map((b) => b.id)).toEqual(["welcome01", "shorttext01", "newid00001"]);
    expect(next.blocks[0]).toBe(WELCOME); // untouched blocks keep identity
  });
});

describe("builderReducer — edit", () => {
  it("updates only the target block's kind-appropriate fields (ids stable)", () => {
    const state = draft([WELCOME, SHORT]);
    const next = builderReducer(state, {
      type: "update_block",
      id: "shorttext01",
      patch: { label: "Your name", required: true, placeholder: "Jane" },
    });
    expect(next.blocks[1]).toEqual({
      id: "shorttext01",
      kind: "short_text",
      label: "Your name",
      required: true,
      placeholder: "Jane",
    });
    expect(next.blocks[0]).toBe(WELCOME);
  });

  it("ignores fields that do not belong to the block kind", () => {
    const next = builderReducer(draft([WELCOME]), {
      type: "update_block",
      id: "welcome01",
      patch: { label: "nope", required: true, title: "Hello", description: "d" },
    });
    expect(next.blocks[0]).toEqual({ id: "welcome01", kind: "welcome", title: "Hello", description: "d" });
  });

  it("drops optional keys when cleared to an empty string (strict envelope stays clean)", () => {
    const described = builderReducer(draft([{ ...SHORT, description: "hi" }]), {
      type: "update_block",
      id: "shorttext01",
      patch: { description: "" },
    });
    expect("description" in described.blocks[0]!).toBe(false);
  });
});

describe("builderReducer — reorder (move up/down buttons and drag)", () => {
  it("move_block swaps with the neighbor in the given direction", () => {
    const state = draft([WELCOME, SHORT, LONG]);
    const up = builderReducer(state, { type: "move_block", id: "longtext01", direction: "up" });
    expect(up.blocks.map((b) => b.id)).toEqual(["welcome01", "longtext01", "shorttext01"]);
    const down = builderReducer(up, { type: "move_block", id: "longtext01", direction: "down" });
    expect(down.blocks.map((b) => b.id)).toEqual(["welcome01", "shorttext01", "longtext01"]);
  });

  it("is a no-op at the edges (first block cannot move up; last cannot move down)", () => {
    const state = draft([WELCOME, SHORT]);
    expect(builderReducer(state, { type: "move_block", id: "welcome01", direction: "up" }).blocks).toEqual(
      state.blocks,
    );
    expect(
      builderReducer(state, { type: "move_block", id: "shorttext01", direction: "down" }).blocks,
    ).toEqual(state.blocks);
  });

  it("move_block_to (drag drop target) moves the block and clamps out-of-range indexes", () => {
    const state = draft([WELCOME, SHORT, LONG, ENDING]);
    const moved = builderReducer(state, { type: "move_block_to", id: "ending01", index: 0 });
    expect(moved.blocks.map((b) => b.id)).toEqual(["ending01", "welcome01", "shorttext01", "longtext01"]);
    expect(
      builderReducer(state, { type: "move_block_to", id: "welcome01", index: -5 }).blocks.map(
        (b) => b.id,
      ),
    ).toEqual(["welcome01", "shorttext01", "longtext01", "ending01"]);
    expect(
      builderReducer(state, { type: "move_block_to", id: "welcome01", index: 99 }).blocks.map(
        (b) => b.id,
      ),
    ).toEqual(["shorttext01", "longtext01", "ending01", "welcome01"]);
  });
});

describe("builderReducer — delete and title", () => {
  it("remove_block deletes only the target block", () => {
    const state = draft([WELCOME, SHORT, ENDING]);
    const next = builderReducer(state, { type: "remove_block", id: "shorttext01" });
    expect(next.blocks.map((b) => b.id)).toEqual(["welcome01", "ending01"]);
  });

  it("set_title edits the envelope (respondent-facing) title only", () => {
    const next = builderReducer(draft([SHORT], "Before"), { type: "set_title", title: "Client intake" });
    expect(next.title).toBe("Client intake");
    expect(next.blocks).toEqual([SHORT]);
  });

  it("leaves schemaVersion, logic, theme and settings untouched", () => {
    const next = builderReducer(draft([SHORT], "t"), { type: "add_block", id: "x", kind: "ending" });
    expect(next.schemaVersion).toBe(1);
    expect(next.logic).toEqual([]);
    expect(next.theme).toEqual({ preset: "default" });
    expect(next.settings).toEqual({});
  });
});

describe("builderReducer — ID stability across a full editing session", () => {
  it("add → edit → reorder (buttons) → reorder (drag) → delete keeps surviving ids identical", () => {
    let state = draft([SHORT, LONG]);

    // Add two more (ids generated outside the reducer, as in the component).
    const actions: BuilderAction[] = [
      { type: "add_block", id: "welcome01", kind: "welcome" },
      { type: "add_block", id: "ending01", kind: "ending" },
      { type: "update_block", id: "shorttext01", patch: { label: "Name", required: true } },
      { type: "move_block", id: "welcome01", direction: "up" }, // already first → no-op
      { type: "move_block", id: "welcome01", direction: "down" },
      { type: "move_block_to", id: "welcome01", index: 0 }, // drag back to front
      { type: "remove_block", id: "ending01" },
    ];
    for (const action of actions) state = builderReducer(state, action);

    expect(state.blocks.map((b) => b.id)).toEqual(["welcome01", "shorttext01", "longtext01"]);
    // Content of survivors survived too:
    expect(state.blocks[1]!.kind).toBe("short_text");
    expect(state.blocks[1]!.kind === "short_text" && state.blocks[1]!.label).toBe("Name");
  });

  it("never mutates the previous state (React state updates stay pure)", () => {
    const state = draft([WELCOME, SHORT]);
    const snapshot = JSON.stringify(state);
    builderReducer(state, { type: "add_block", id: "x", kind: "ending" });
    builderReducer(state, { type: "move_block", id: "welcome01", direction: "down" });
    builderReducer(state, { type: "remove_block", id: "welcome01" });
    builderReducer(state, { type: "update_block", id: "shorttext01", patch: { label: "z" } });
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
