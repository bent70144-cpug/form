# 12: Deploy M0 and run the alpha smoke test

**Spec:** `../spec.md`

**What to build:** Verify the completed M0 on the alpha: admin bootstrap, GitHub Actions migrations, real email, the full create → publish → submit → review flow, cold-start behavior, and process-level secret separation.

**Blocked by:** 04, 11

**Status:** ready-for-agent

- [ ] The one-time admin bootstrap script has run on Neon and created the schemas and the `migrator`, `app_user`, `worker_user`, and NOLOGIN `fn_owner` roles. No role password appears in a migration file, and the migrator password is absent from Render's runtime environment.
- [ ] GitHub Actions ran the migrations as `migrator` before triggering the Render deploy; Render auto-deploy on push is disabled, and the migrator URL exists only as a GitHub Actions secret, not in Render's runtime environment. The app connects as `app_user`, the worker as `worker_user`, and security-definer functions are owned by `fn_owner`.
- [ ] The HTTPS email adapter wired in ticket 03 works; verification and password reset succeed without Mailpit. The provider sandbox may deliver only to the owner's address during development.
- [ ] Before the first outside tester, a sending domain is owned and verified with the email provider (roughly $10/year; confirm current pricing); `onrender.com` cannot be verified as a sender domain.
- [ ] A live signup → create form → publish → submit → review run completes on the alpha.
- [ ] Cold-start behavior is measured, including the authenticated SSR session hop.
- [ ] The supervisor passes each child an explicit allowlisted environment. A test asserts the Next process environment contains no `DATABASE_URL`, auth secret, or migrator URL. This is process-level separation only; real service isolation arrives at the beta split.
- [ ] The health endpoint reports correctly and logs contain no tenant data or secrets.
- [ ] The auth hardening from ticket 04 is present in the deployed build.
