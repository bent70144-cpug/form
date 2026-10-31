import { describe, expect, it } from "vitest";
import { t, en } from "../src/index";

describe("i18n", () => {
  it("resolves typed keys, e.g. common.health.ok", () => {
    expect(t("common.health.ok")).toBe(en.common.health.ok);
    expect(typeof t("errors.validation.title")).toBe("string");
  });

  it("returns catalog strings verbatim without params", () => {
    expect(t("common.appName")).toBe(en.common.appName);
  });

  it("throws on keys missing from the catalog (catalog drift is a bug)", () => {
    // @ts-expect-error — intentionally invalid key
    expect(() => t("does.not.exist")).toThrow(/Missing i18n message/);
  });
});
