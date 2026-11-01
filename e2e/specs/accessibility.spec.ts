import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import {
  browserAvailable,
  browserSkipReason,
  createFormAndPublish,
  signIn,
  signUpAndVerify,
  submitPublicForm,
  uniqueUser,
  type BuiltForm,
} from "../helpers/flow";

/**
 * Ticket 11 — accessibility seam. Axe runs INSIDE Playwright on every page
 * of the M0 surface: sign-in, the dashboard form list, the builder, the
 * inbox list and detail, and the public form. Any SERIOUS or CRITICAL
 * violation fails the check (the spec's bar); moderate/minor issues are
 * reported but tolerated.
 *
 * The suite skips cleanly like the happy path when Chromium cannot launch.
 *
 * Session plumbing: one authoring context signs up, builds + publishes a
 * form and submits one answer (so the inbox checks run against REAL
 * content), then saves its storage state; the authenticated checks each
 * create a context from that state.
 */

test.skip(!browserAvailable(), browserSkipReason());

const AUTHOR_STATE = path.join(__dirname, "..", ".auth", "author.json");

/** The form built in the authoring step (shared by all checks below). */
let form: BuiltForm;

async function expectNoSeriousViolations(
  page: Page,
  context: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  if (serious.length > 0) {
    const summary = serious
      .map((v) => `${v.id} [${v.impact}]: ${v.nodes.length} node(s) — ${v.help}`)
      .join("\n");
    throw new Error(
      `axe found serious violations on ${context}:\n${summary}`,
    );
  }
  expect(serious).toHaveLength(0);
}

test.describe("authoring + signed-out pages", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const user = uniqueUser("e2e-a11y");
    await signUpAndVerify(page, user);
    await signIn(page, user);
    form = await createFormAndPublish(page, {
      questionLabel: "Accessibility question",
      endingTitle: "A11y ending",
    });
    fs.mkdirSync(path.dirname(AUTHOR_STATE), { recursive: true });
    await page.context().storageState({ path: AUTHOR_STATE });
    await page.close();

    // One public submission so the inbox is not empty.
    const respondent = await browser.newPage();
    await submitPublicForm(respondent, form, "A11y answer");
    await respondent.close();
  }, 240_000);

  test("sign-in page has no serious violations", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("button")).toBeVisible();
    await expectNoSeriousViolations(page, "sign-in");
  });

  test("public form has no serious violations", async ({ page }) => {
    await page.goto(form.publicUrl);
    await expect(page.getByLabel(/^Accessibility question/)).toBeVisible();
    await expectNoSeriousViolations(page, "public form");
  });
});

test.describe("authenticated dashboard pages", () => {
  test("dashboard form list has no serious violations", async ({ browser }) => {
    const context = await browser.newContext({ storageState: AUTHOR_STATE });
    const page = await context.newPage();
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Forms" })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoSeriousViolations(page, "dashboard form list");
    await context.close();
  });

  test("builder has no serious violations", async ({ browser }) => {
    const context = await browser.newContext({ storageState: AUTHOR_STATE });
    const page = await context.newPage();
    await page.goto(form.formUrl);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousViolations(page, "builder");
    await context.close();
  });

  test("inbox list has no serious violations", async ({ browser }) => {
    const context = await browser.newContext({ storageState: AUTHOR_STATE });
    const page = await context.newPage();
    await page.goto(`${form.formUrl}/inbox`);
    await expect(page.getByText("A11y answer").first()).toBeVisible();
    await expectNoSeriousViolations(page, "inbox list");
    await context.close();
  });

  test("inbox detail has no serious violations", async ({ browser }) => {
    const context = await browser.newContext({ storageState: AUTHOR_STATE });
    const page = await context.newPage();
    await page.goto(`${form.formUrl}/inbox`);
    await page.getByText("A11y answer").first().click();
    await expect(page.getByText("A11y answer")).toBeVisible();
    await expectNoSeriousViolations(page, "inbox detail");
    await context.close();
  });
});
