/**
 * English message catalog (M0 ships English only, spec: "An i18n package owns
 * message catalogs and helpers; M0 ships English only but externalizes
 * strings").
 *
 * Rules:
 * - User-facing strings live here, referenced by dot-separated keys
 *   (e.g. `t('common.health.ok')`).
 * - API error messages resolve titles/details by key, never hardcoded.
 * - `{placeholder}` interpolation is provided by `t(key, params)`.
 */
export const en = {
  common: {
    appName: "Form",
    health: {
      ok: "Service is healthy",
      unreachable: "Service is alive but the database is unreachable",
    },
    loading: "Loading…",
  },
  home: {
    title: "Collect structured client intake, safely",
    subtitle:
      "A hosted workspace for conversational forms — one client's data never sees another's.",
    openDashboard: "Open dashboard",
  },
  dashboard: {
    title: "Dashboard",
    placeholderNote:
      "The M0 dashboard is a placeholder. Authentication and workspaces arrive in the next slices.",
  },
  errors: {
    validation: { title: "Validation failed" },
    malformed: { title: "Malformed request" },
    unauthenticated: { title: "Unauthenticated" },
    forbidden: { title: "Forbidden" },
    notFound: { title: "Not found" },
    conflict: { title: "Conflict" },
    rateLimited: { title: "Too many requests" },
    internal: { title: "Unexpected error" },
    notImplemented: { title: "Not implemented" },
  },
} as const;

export type Catalog = typeof en;
