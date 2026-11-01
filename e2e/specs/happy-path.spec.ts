import { test, expect } from "@playwright/test";
import {
  browserAvailable,
  browserSkipReason,
  createFormAndPublish,
  openInboxAndAssertRow,
  signIn,
  signUpAndVerify,
  submitPublicForm,
  uniqueUser,
} from "../helpers/flow";
import { t } from "../helpers/i18n";

/**
 * Ticket 11 — THE browser happy path (spec seam 1, primary acceptance).
 *
 * signup → email verification through the mail sink API → workspace
 * bootstrap → create form → add blocks via the builder UI → publish → open
 * the public URL → fill + submit → the dashboard inbox shows the submission
 * → open the detail view pairing each answer beside its question label.
 *
 * The whole suite skips cleanly (see e2e/global-setup.ts) when Chromium
 * cannot launch in this sandbox; the API seam keeps covering the behavior.
 */

test.skip(!browserAvailable(), browserSkipReason());

test.describe("submission happy path", () => {
  test("signup → verify → workspace → build → publish → submit → inbox review", async ({
    page,
  }) => {
    const user = uniqueUser("e2e-happy");
    const answer = `Ada Lovelace ${Date.now()}`;

    await signUpAndVerify(page, user);
    await signIn(page, user);

    const form = await createFormAndPublish(page, {
      questionLabel: "What is your name?",
      endingTitle: "Thanks for submitting!",
    });

    await submitPublicForm(page, form, answer);

    // Dashboard review: the inbox list carries the submission…
    await openInboxAndAssertRow(page, form.formId, answer);

    // …and the detail view pairs the answer beside the question label.
    await page.getByText(answer).first().click();
    await expect(
      page.getByRole("heading", { name: t("dashboard.inbox.answersHeading") }),
    ).toBeVisible();
    await expect(
      page.getByText("What is your name?", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText(answer)).toBeVisible();
    await expect(
      page.getByText(/^Form version 1$/),
    ).toBeVisible();
    await expect(page.getByText(/^Received /)).toBeVisible();
  });

  test("empty inbox shows the i18n empty state", async ({ page }) => {
    const user = uniqueUser("e2e-empty");
    await signUpAndVerify(page, user);
    await signIn(page, user);

    const form = await createFormAndPublish(page, {
      questionLabel: "Untouched question",
      endingTitle: "The end",
    });

    await page.goto(`/dashboard/forms/${form.formId}/inbox`);
    await expect(page.getByText(t("dashboard.inbox.empty"))).toBeVisible();
  });
});
