import { describe, expect, it } from "vitest";
import { isUuid, uuidv7 } from "../src/uuid";

describe("uuidv7", () => {
  it("produces an RFC 9562 v7 UUID with correct version and variant bits", () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("encodes the given timestamp in the first 48 bits", () => {
    const now = 1_735_000_000_000; // fixed epoch ms
    const id = uuidv7(now);
    const hex = id.replace(/-/g, "");
    const ts = BigInt(`0x${hex.slice(0, 12)}`);
    expect(ts).toBe(BigInt(now));
  });

  it("is time-sortable: later timestamps sort after earlier ones", () => {
    const early = uuidv7(1_000_000_000_000);
    const late = uuidv7(1_000_000_000_500);
    expect(early < late).toBe(true);
  });

  it("generates unique values across rapid calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7()));
    expect(ids.size).toBe(500);
  });
});

describe("isUuid", () => {
  it("accepts canonical UUIDs", () => {
    expect(isUuid(uuidv7())).toBe(true);
    expect(isUuid("0b8f6c1e-8f3a-4d2e-9a1b-2c3d4e5f6a7b")).toBe(true);
  });

  it("rejects junk, empty strings, and wrong shapes", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("0b8f6c1e8f3a4d2e9a1b2c3d4e5f6a7b")).toBe(false);
    expect(isUuid("0b8f6c1e-8f3a-4d2e-9a1b-2c3d4e5f6a7")).toBe(false);
  });
});
