import { describe, expect, it } from "vitest";
import { createLogicEngine, LogicNotImplementedError } from "../src/index";

describe("logic package boundary (M0)", () => {
  it("exposes a port stub that refuses evaluation", () => {
    const engine = createLogicEngine();
    expect(() =>
      engine.evaluate(
        [{ id: "b1", kind: "short_text", producesAnswer: true }],
        {},
      ),
    ).toThrow(LogicNotImplementedError);
  });
});
