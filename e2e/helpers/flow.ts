import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { t } from "./i18n";

/**
 * Shared browser flow helpers (ticket 11 — the spec's seam 1 happy path):
 * signup → verification through the mail sink API → workspace bootstrap →
 * create form → builder blocks → publish → public submission → inbox review.
 * Every asserted string is the SAME i18n catalog value the UI renders.
 */

/** The dev mail sink's REST mailbox (Mailpit substitute — see ENVIRONMENT notes). */
export function mailSinkUrl(): string {
  return process.env.E2E_SINK_URL ?? "http://127.0.0.1:5434/dev/mailbox";
}

function baseOrigin(): string {
  // The canonical dev origin — must equal the supervisor's APP_ORIGIN default
  // (the origin guard rejects cross-origin state changes) and the Playwright
  // baseURL, so every hop (dashboard, API rewrite, public form) stays
  // same-origin.
  return process.env.E2E_BASE_URL ?? "http://localhost:3000";
}

/**
 * Whether the global-setup browser probe succeeded. Spec files call
 * `test.skip(!browserAvailable(), browserSkipReason())` so a sandbox without
 * the Chromium system libraries skips cleanly instead of failing.
 */
export function browserAvailable(): boolean {
  try {
    const status = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", ".browser-status.json"), "utf8"),
    ) as { ok: boolean };
    return status.ok === true;
  } catch {
    return false;
  }
}

export function browserSkipReason(): string {
  try {
    const status = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", ".browser-status.json"), "utf8"),
    ) as { reason?: string };
    return (
      "chromium unavailable in this sandbox (missing system libs; no sudo) — " +
      `browser seam skipped; see e2e/global-setup.ts. ${status.reason ?? ""}`
    );
  } catch {
    return "chromium unavailable in this sandbox — browser seam skipped.";
  }
}

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

export function uniqueUser(prefix: string): TestUser {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: `${prefix} Tester`,
    email: `${prefix}-${stamp}@e2e.example`,
    password: "correct-horse-12",
  };
}

interface Mailbox {
  messages: Array<{ id: number; to: string[]; raw: string }>;
}

/** Waits for the verification mail to land in the sink and extracts the URL. */
export async function waitForVerificationUrl(
  email: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(mailSinkUrl());
    if (res.ok) {
      const mailbox = (await res.json()) as Mailbox;
      const message = mailbox.messages.find((m) =>
        m.to.some((to) => to.includes(email)),
      );
      if (message) {
        const match = message.raw.match(
          /https?:\/\/\S+\/v1\/auth\/verify-email\?token=\S+/,
        );
        if (match) return match[0].replace(/["\s]+$/, "");
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no verification mail for ${email} within ${timeoutMs}ms`);
}

/** Signs up through the UI and completes email verification via the sink. */
export async function signUpAndVerify(page: Page, user: TestUser): Promise<void> {
  await page.goto("/sign-up");
  await page.getByLabel(t("auth.signUp.nameLabel")).fill(user.name);
  await page.getByLabel(t("auth.signUp.emailLabel")).fill(user.email);
  await page.getByLabel(t("auth.signUp.passwordLabel")).fill(user.password);
  await page.getByRole("button", { name: t("auth.signUp.submit") }).click();
  // Enumeration-safe notice — identical for existing and new addresses.
  await expect(
    page.getByRole("heading", { name: t("auth.signUp.checkInboxTitle") }),
  ).toBeVisible();

  // The mail's link points at APP_ORIGIN (localhost:3000); the verification
  // endpoint is cookie-less (token in the query), so following it directly
  // is origin-safe.
  const url = await waitForVerificationUrl(user.email);
  await page.goto(url);
  await expect(page.getByText(t("auth.verifyEmail.success"))).toBeVisible();
}

/** Signs in through the UI and waits for the dashboard shell. */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel(t("auth.signIn.emailLabel")).fill(user.email);
  await page.getByLabel(t("auth.signIn.passwordLabel")).fill(user.password);
  await page.getByRole("button", { name: t("auth.signIn.submit") }).click();
  await expect(
    page.getByRole("heading", { name: t("dashboard.title") }),
  ).toBeVisible();
}

/**
 * Waits for the dashboard to reach the bootstrapped state: the workspace
 * stepper auto-runs on first visit (BootstrapWorkspace), then the form list
 * heading appears.
 */
export async function ensureWorkspace(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: t("dashboard.forms.title") }),
  ).toBeVisible({ timeout: 30_000 });
}

export interface BuiltForm {
  /** /dashboard/forms/{id} — the builder URL after creation. */
  formUrl: string;
  formId: string;
  publicUrl: string;
  questionLabel: string;
  endingTitle: string;
}

/**
 * Creates a form through the dashboard, adds one short-text question and an
 * ending block via the BUILDER UI, waits for the autosave, publishes, and
 * returns the coordinates the public submission + inbox steps need.
 */
export async function createFormAndPublish(
  page: Page,
  options: { questionLabel: string; endingTitle: string },
): Promise<BuiltForm> {
  await ensureWorkspace(page);
  await page
    .getByRole("button", { name: t("dashboard.forms.newForm") })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Builder: add a short-text question and label it, then an ending block.
  await page
    .getByRole("button", { name: t("dashboard.builder.add.shortText") })
    .click();
  await page
    .getByLabel(t("dashboard.builder.labelLabel"))
    .fill(options.questionLabel);
  await page
    .getByRole("button", { name: t("dashboard.builder.add.ending") })
    .click();
  await page
    .getByLabel(t("dashboard.builder.titleLabel"))
    .fill(options.endingTitle);

  // Autosave completes before we leave the page.
  await expect(page.getByText(t("dashboard.builder.status.saved"))).toBeVisible();

  // Publish controls (T09): publish, then take the public URL from the UI.
  await page
    .getByRole("button", {
      name: t("dashboard.publish.publish"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(t("dashboard.publish.status.published")).first(),
  ).toBeVisible();
  const publicUrl = await page
    .getByRole("link", { name: t("dashboard.publish.openPublicPage") })
    .getAttribute("href");
  if (!publicUrl) throw new Error("public link not rendered after publish");

  const formUrl = page.url();
  const formId = new URL(formUrl).pathname.split("/")[3] ?? "";
  return {
    formUrl,
    formId,
    publicUrl: new URL(publicUrl, baseOrigin()).toString(),
    questionLabel: options.questionLabel,
    endingTitle: options.endingTitle,
  };
}

/** Fills and submits the public form (the respondent side). */
export async function submitPublicForm(
  page: Page,
  form: BuiltForm,
  answer: string,
): Promise<void> {
  await page.goto(form.publicUrl);
  // The rendered label is "{label} ({required|optional})" — prefix match.
  const field = page.getByLabel(
    new RegExp(`^${escapeRegExp(form.questionLabel)}`),
  );
  await field.fill(answer);
  await page
    .getByRole("button", { name: t("public.form.submitButton") })
    .click();
  // The pinned ending block closes the conversation.
  await expect(
    page.getByRole("heading", { name: form.endingTitle }),
  ).toBeVisible();
}

/** Opens the dashboard inbox list and asserts the submission row is there. */
export async function openInboxAndAssertRow(
  page: Page,
  formId: string,
  answer: string,
): Promise<void> {
  await page.goto(`/dashboard/forms/${formId}/inbox`);
  await expect(
    page.getByRole("heading", { name: t("dashboard.inbox.title") }),
  ).toBeVisible();
  // The first-answer preview carries the submitted text.
  await expect(page.getByText(answer).first()).toBeVisible();
  await expect(page.getByText(/^Received /).first()).toBeVisible();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
