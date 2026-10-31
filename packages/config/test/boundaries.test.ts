import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Dependency rule (spec: "apps may depend on packages, packages may depend on
 * packages, and no package may depend on an app").
 *
 * Belt and braces with the ESLint rule in packages/config/eslint/index.mjs
 * (APP_PACKAGE_PATTERN): this test scans every package source file for
 * imports of an app specifier or a relative path escaping into apps/.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");
const APP_SPECIFIERS = ["@form/web", "@form/api", "@form/worker"];

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SOURCE_RE.test(entry.name)) yield full;
  }
}

const IMPORT_RE =
  /(?:from\s*['"]|import\s*\(\s*['"]|require\s*\(\s*['"])([^'"]+)['"]/g;

describe("package dependency boundaries", () => {
  it("no package imports an app package", () => {
    const violations = [];
    for (const pkg of fs.readdirSync(PACKAGES_DIR)) {
      const src = path.join(PACKAGES_DIR, pkg, "src");
      if (!fs.existsSync(src)) continue;
      for (const file of walk(src)) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(IMPORT_RE)) {
          const spec = match[1];
          if (spec === undefined) continue;
          if (APP_SPECIFIERS.some((a) => spec === a || spec.startsWith(`${a}/`))) {
            violations.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no package source file lives outside packages/ (relative escape into apps/)", () => {
    const violations = [];
    for (const pkg of fs.readdirSync(PACKAGES_DIR)) {
      const src = path.join(PACKAGES_DIR, pkg, "src");
      if (!fs.existsSync(src)) continue;
      for (const file of walk(src)) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(IMPORT_RE)) {
          const spec = match[1];
          if (!spec?.startsWith(".")) continue;
          const resolved = path.resolve(path.dirname(file), spec);
          if (!resolved.startsWith(PACKAGES_DIR + path.sep)) {
            violations.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
