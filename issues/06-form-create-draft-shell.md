# 06: Create form and manage the draft shell

**Spec:** `../spec.md`

**What to build:** Create, list, read, and rename a form in the active workspace; a mutable draft row exists; the dashboard shows the form list and a form page; `form.created` is audited and emitted to the outbox.

**Blocked by:** 05

**Status:** done

- [x] The form-schema package skeleton and `emptyDraft()` land here, before validation is added in ticket 07. The empty envelope is exactly `{ schemaVersion: 1, title: "", blocks: [], logic: [], theme: { preset: "default" }, settings: {} }`; the package exports `emptyDraft()` and the default theme/settings.
- [x] A form can be created in the active workspace and the default project, listed, read, and renamed. The default project is found through `projects.is_default`, not by matching the name `General`.
- [x] A mutable draft row is created with the empty envelope and integer `draft_version` 0; the form page shell renders the draft.
- [x] `forms.name` is the dashboard label and is not respondent-facing. Respondents see the pinned schema's `title`; the form page exposes that title for editing, and a dashboard rename changes only `forms.name`.
- [x] `form.created` is written to the audit log and the outbox and processed by the dispatcher.
- [x] `forms`, `form_drafts`, and `projects` have forced RLS with both `USING` and `WITH CHECK`; cross-workspace reads and writes return 404. Tenant foreign keys use `(workspace_id, id)` composites.
- [x] The builder block editing, publishing, and public pages are not implemented in this slice.
- [x] API and browser tests cover create, list, rename, respondent-facing title, draft existence, default-project lookup by flag, and cross-workspace denial.

## Implementation notes (2026-10-31)

- Forms create/list/read/rename over the tenant interceptor (workspace-context markers); default project resolved by `projects.is_default` flag (proven with a renamed default project in tests); cursor pagination default 20 max 100; cross-workspace 404.
- form_drafts row created atomically with `emptyDraft()` envelope + `draft_version` 0; form page shell renders the draft. `form.created` audited + outbox event processed by the worker handler.
- Respondent-facing title lives in the schema (untouched by dashboard rename). form-schema package skeleton + `emptyDraft()` validated (the full validation library landed via the parallel ticket-07 slice).
