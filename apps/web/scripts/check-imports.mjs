#!/usr/bin/env node
/**
 * Build-time import boundary check for apps/web (spec guardrail: "The web
 * build and lint fail if the web app imports the database package or the
 * server auth entrypoint").
 *
 * Runs automatically as part of `pnpm --filter @form/web build` (prebuild) in
 * addition to the ESLint no-restricted-imports rule, so a config drift cannot
 * silently re-allow database code into the browser deployable.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FORBIDDEN_IMPORTS = ["@form/database", "@form/auth/server"];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SCAN_DIRS = ["app", "src", "components", "lib", "pages", "scripts"];
const IMPORT_RE =
  /(?:from\s*['"]|import\s*\(\s*['"]|require\s*\(\s*['"]|import\s*['"])([^'"]+)['"]/g;

export function findForbiddenImports(dir) {
  const violations = [];

  const checkSource = (full) => {
    const source = fs.readFileSync(full, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (
        FORBIDDEN_IMPORTS.some(
          (f) => specifier === f || specifier.startsWith(`${f}/`),
        )
      ) {
        violations.push({ file: full, specifier });
      }
    }
  };

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        checkSource(full);
      }
    }
  };

  for (const sub of SCAN_DIRS) {
    const target = path.join(dir, sub);
    if (fs.existsSync(target)) walk(target);
  }
  // Top-level config files may also pull imports (e.g. next.config.ts).
  for (const file of ["next.config.ts", "next.config.mjs", "next.config.js"]) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) checkSource(full);
  }
  return violations;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const root = path.resolve(
    path.dirname(fileURLToPathCompat(import.meta.url)),
    "..",
  );
  const violations = findForbiddenImports(root);
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `web-import-boundary: ${path.relative(root, v.file)} imports "${v.specifier}"\n`,
      );
    }
    process.stderr.write(
      "The web app must never import database or server-auth code.\n",
    );
    process.exit(1);
  }
  process.stdout.write("web-import-boundary: OK\n");
}

function fileURLToPathCompat(url) {
  return url.startsWith("file://") ? url.slice("file://".length) : url;
}
