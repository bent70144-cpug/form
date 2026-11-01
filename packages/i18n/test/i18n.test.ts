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

  it("ships the ticket-04 reset + rate-limit keys (spec: auth errors use i18n keys)", () => {
    // ONE shared enumeration-safe response key (reset + future flows).
    expect(t("auth.enumerationSafeResponse", { email: "a@b.c" })).toContain("a@b.c");
    // Reset email copy (subject + body carry the single-use 1 h link).
    expect(t("auth.email.resetSubject")).toContain("Reset");
    expect(t("auth.email.resetBody", { name: "U", url: "http://x/y" })).toContain("http://x/y");
    // The 429 problem title key referenced by the rateLimited() factory.
    expect(t("errors.rateLimited.title")).toContain("Too many");
  });

  it("ships the ticket-08 builder keys (all builder copy is catalog-driven)", () => {
    expect(t("dashboard.builder.status.saved")).toContain("saved");
    expect(t("dashboard.builder.status.saving")).toContain("Saving");
    expect(t("dashboard.builder.moveUp", { name: "Short text" })).toBe(
      "Move Short text up",
    );
    expect(t("dashboard.builder.deleteBlock", { name: "Ending" })).toBe(
      "Delete Ending",
    );
    expect(typeof en.dashboard.builder.schemaTitleLabel).toBe("string");
    expect(typeof en.dashboard.builder.validationHeading).toBe("string");
    expect(typeof en.dashboard.builder.add.welcome).toBe("string");
    expect(typeof en.dashboard.builder.status.reload).toBe("string");
  });
});
