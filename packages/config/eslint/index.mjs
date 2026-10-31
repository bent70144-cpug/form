/**
 * Shared ESLint flat-config presets for the form monorepo.
 * Lives in @form/config (the guardrail package) and is imported by the root
 * config and by app-level configs. Plain .mjs on purpose: ESLint loads it
 * without a build step.
 */
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

/**
 * Import specifiers the web app must NEVER import.
 * - `@form/database`  — the only package allowed to touch Postgres; the browser
 *   deployable must never get database credentials.
 * - `@form/auth/server` — the DB-backed Better Auth entrypoint; only the API
 *   may import it.
 */
export const WEB_RESTRICTED_IMPORTS = ["@form/database", "@form/auth/server"];

/** Apps may be imported by nothing — packages must not depend on apps. */
export const APP_PACKAGE_PATTERN = "^@form/(web|api|worker)(/.*)?$";

function restricted(patterns, message) {
  return [
    "error",
    {
      patterns: patterns.map((p) => ({
        group: [p, `${p}/**`],
        message,
      })),
    },
  ];
}

/**
 * Base config shared by everything: TS recommended rules + prettier compat.
 */
export function baseConfig() {
  return [
    {
      ignores: [
        "**/dist/**",
        "**/node_modules/**",
        "**/.next/**",
        "**/coverage/**",
        "**/.turbo/**",
        "**/.fixture/**",
      ],
    },
    ...tseslint.configs.recommended,
    eslintConfigPrettier,
    {
      rules: {
        "@typescript-eslint/consistent-type-imports": [
          "warn",
          { prefer: "type-imports" },
        ],
        // Interface-conformance params are prefixed with `_` (e.g. queue
        // adapters implementing the port with unused hook arguments).
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
        "no-console": "off",
      },
    },
  ];
}

/**
 * Rules for workspace packages: no package may import an app, and no package
 * may import the server auth entrypoint (only apps/api may do that).
 */
export function packageOverrides() {
  return [
    {
      files: ["packages/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                regex: APP_PACKAGE_PATTERN,
                message:
                  "Packages must not depend on apps (dependency rule: apps -> packages only).",
              },
              {
                regex: "^@form/auth/server(/.*)?$",
                message:
                  "@form/auth/server may only be imported by apps/api.",
              },
            ],
          },
        ],
      },
    },
  ];
}

/**
 * Rules for the web app: fail lint when the browser deployable imports the
 * database package or the server auth entrypoint.
 */
export function webOverrides() {
  return [
    {
      files: ["apps/web/**/*.{ts,tsx,js,jsx,mjs}"],
      rules: {
        "no-restricted-imports": restricted(
          WEB_RESTRICTED_IMPORTS,
          "The web app must not import database or server-auth code (it never receives DB credentials).",
        ),
      },
    },
  ];
}

/**
 * The standalone config for apps/web (used by `eslint` inside apps/web and by
 * the import-boundary test).
 */
export function defineWebConfig() {
  return [...baseConfig(), ...webOverrides()];
}

/** The root config covering the whole monorepo. */
export function defineRootConfig() {
  return [...baseConfig(), ...packageOverrides(), ...webOverrides()];
}
