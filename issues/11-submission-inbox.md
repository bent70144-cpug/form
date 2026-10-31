# 11: Submission inbox and detail

**Spec:** `../spec.md`

**What to build:** The dashboard inbox with a cursor-paginated submission list per form and a detail view that pairs each answer with the question label from the pinned version, plus the full browser end-to-end path and an accessibility check.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] The submission list is newest-first, cursor-paginated, default 20, maximum 100.
- [ ] The detail view shows each answer beside the question label from the pinned version, plus the received time and form version. Labels and answers render as escaped plain text.
- [ ] Cross-workspace list and detail requests return 404; RLS tests cover the submission tables.
- [ ] The Playwright happy path covers signup, verification, workspace creation, form building, publishing, public submission, and dashboard review.
- [ ] An accessibility check runs inside Playwright for sign-in, the dashboard form list, the builder, the submission list and detail, and the public form, and fails on serious violations.
- [ ] Inbox labels, empty states, dates, and errors use i18n keys.
- [ ] CSV export and analytics are not implemented in this slice.
