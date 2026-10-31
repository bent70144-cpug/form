import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  FORBIDDEN_IMPORTS,
  findForbiddenImports,
} from "../../apps/web/scripts/check-imports.mjs";
import { WEB_RESTRICTED_IMPORTS } from "../../packages/config/eslint/index.mjs";

const require = createRequire(import.meta.url);

/**
 * Import-boundary guardrail tests (spec: "The web build and lint fail if the
 * web app imports the database package or the server auth entrypoint").
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const WEB_ROOT = path.join(REPO_ROOT, "apps/web");

let lintDir;

beforeAll(() => {
  // The webOverrides() rule is scoped with `files: ["apps/web/**..."]`, which
  // ESLint matches relative to the config base path (cwd). Fixtures therefore
  // live INSIDE apps/web and lint with the repo root as cwd — the same shape
  // as the CI root lint — so the scoped rule actually applies.
  lintDir = fs.mkdtempSync(path.join(WEB_ROOT, ".boundary-fixture-"));
  fs.mkdirSync(path.join(lintDir, "src"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(lintDir, { recursive: true, force: true });
});

async function lintFixture(fileName, source) {
  const filePath = path.join(lintDir, "src", fileName);
  fs.writeFileSync(filePath, source);
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: (await import("../../apps/web/eslint.config.mjs")).default,
  });
  const results = await eslint.lintText(source, { filePath });
  return results[0].messages;
}

describe("web import boundary (eslint rule)", () => {
  it("declares exactly the two forbidden specifiers", () => {
    expect(WEB_RESTRICTED_IMPORTS).toEqual([
      "@form/database",
      "@form/auth/server",
    ]);
  });

  it("fires no-restricted-imports when web imports @form/database", async () => {
    const messages = await lintFixture(
      "bad-database.tsx",
      `import { createPool } from "@form/database";\nexport const pool = createPool("");\n`,
    );
    expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(
      true,
    );
  });

  it("fires no-restricted-imports when web imports @form/auth/server", async () => {
    const messages = await lintFixture(
      "bad-auth-server.tsx",
      `import { createAuthHandlerStub } from "@form/auth/server";\nexport const stub = createAuthHandlerStub();\n`,
    );
    expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(
      true,
    );
  });

  it("does not flag allowed shared packages", async () => {
    const messages = await lintFixture(
      "good.tsx",
      `import { t } from "@form/i18n";\nexport const label = t("common.health.ok");\n`,
    );
    expect(messages.filter((m) => m.severity === 2)).toEqual([]);
  });
});

describe("web import boundary (build-time script)", () => {
  it("detects a forbidden import in a scanned source tree", () => {
    const caseDir = path.join(lintDir, "case-offend");
    fs.mkdirSync(path.join(caseDir, "app"), { recursive: true });
    fs.writeFileSync(
      path.join(caseDir, "app", "page.tsx"),
      `import { runMigrations } from "@form/database";\nexport default null;\n`,
    );
    const violations = findForbiddenImports(caseDir);
    expect(violations).toHaveLength(1);
    expect(violations[0].specifier).toBe("@form/database");
  });

  it("passes a clean source tree", () => {
    const caseDir = path.join(lintDir, "case-clean");
    fs.mkdirSync(path.join(caseDir, "app"), { recursive: true });
    fs.writeFileSync(
      path.join(caseDir, "app", "page.tsx"),
      `import { t } from "@form/i18n";\nexport default null;\n`,
    );
    expect(findForbiddenImports(caseDir)).toEqual([]);
  });

  it("forbidden list matches the eslint rule", () => {
    expect(FORBIDDEN_IMPORTS).toEqual(WEB_RESTRICTED_IMPORTS);
  });

  it("the actual web app source is clean right now", () => {
    const webRoot = path.resolve(import.meta.dirname, "../../apps/web");
    expect(findForbiddenImports(webRoot)).toEqual([]);
  });
});

// eslint must be resolvable from this package (it is a devDep of the monorepo root).
void require("eslint/package.json").version;
