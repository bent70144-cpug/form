# 06: Create form and manage the draft shell

**Spec:** `../spec.md`

**What to build:** Create, list, read, and rename a form in the active workspace; a mutable draft row exists; the dashboard shows the form list and a form page; `form.created` is audited and emitted to the outbox.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] The form-schema package skeleton and `emptyDraft()` land here, before validation is added in ticket 07. The empty envelope is exactly `{ schemaVersion: 1, title: "", blocks: [], logic: [], theme: { preset: "default" }, settings: {} }`; the package exports `emptyDraft()` and the default theme/settings.
- [ ] A form can be created in the active workspace and the default project, listed, read, and renamed. The default project is found through `projects.is_default`, not by matching the name `General`.
- [ ] A mutable draft row is created with the empty envelope and integer `draft_version` 0; the form page shell renders the draft.
- [ ] `forms.name` is the dashboard label and is not respondent-facing. Respondents see the pinned schema's `title`; the form page exposes that title for editing, and a dashboard rename changes only `forms.name`.
- [ ] `form.created` is written to the audit log and the outbox and processed by the dispatcher.
- [ ] `forms`, `form_drafts`, and `projects` have forced RLS with both `USING` and `WITH CHECK`; cross-workspace reads and writes return 404. Tenant foreign keys use `(workspace_id, id)` composites.
- [ ] The builder block editing, publishing, and public pages are not implemented in this slice.
- [ ] API and browser tests cover create, list, rename, respondent-facing title, draft existence, default-project lookup by flag, and cross-workspace denial.
