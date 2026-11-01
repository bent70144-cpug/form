# 08: Builder UI for the M0 blocks

**Spec:** `../spec.md`

**What to build:** The dashboard builder UI to add, edit, reorder, and delete welcome, short-text, long-text, and ending blocks, with required/placeholder controls and saved-state indication.

**Blocked by:** 07

**Status:** done

- [x] A creator can add each of the four M0 block kinds.
- [x] A creator can edit the form's respondent-facing schema title and each block's title or label, description, placeholder, and required flag for the relevant block kinds.
- [x] A creator can reorder and delete blocks with drag controls and with move-up and move-down buttons, so reordering is keyboard-accessible. The builder generates a new 12-character URL-safe block ID on add and never regenerates it on edit or reorder.
- [x] Saving sends the draft with the last-seen integer `draft_version`, persists it through the API, and reloading the form restores it. Draft saves are serialized so one tab cannot conflict with its own in-flight save.
- [x] The UI shows saved, saving, and error states.
- [x] On a 409 `draft_conflict`, the UI stops autosaving and offers reload instead of silently overwriting another tab.
- [x] Client-side validation mirrors the shared schema, while the server remains authoritative.
- [x] All builder labels, hints, saved-state text, and errors are looked up through i18n keys.
- [x] Basic keyboard and focus behavior is usable; statement, logic, and theme controls are not present.
- [x] API and browser tests cover add, edit, reorder by drag and by buttons, delete, save, reload, serialized saves, invalid-schema handling, block-ID stability, and the stale-`draft_version` conflict.

## Implementation notes (2026-10-31)

- Builder add/edit/reorder (drag + move-up/down buttons, keyboard-accessible)/delete for welcome, short-text, long-text, ending blocks; respondent-facing schema title editable; required/placeholder controls; 12-char nanoid block IDs generated on add and never regenerated on edit/reorder; serialized saves (one tab cannot conflict with itself); saved/saving/error states with 409 `draft_conflict` -> stop autosave + reload offer; client validation mirrors the shared schema (server authoritative); all strings via i18n keys. Web suite 64/64 at merge.
