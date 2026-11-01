import { test, expect, type Page } from "@playwright/test";
import {
  assertNoHorizontalScroll,
  assertNoSeriousAxeViolations,
  clearMailbox,
  extractVerificationUrl,
  signIn,
  uniqueEmail,
  waitForDraftSettled,
  waitForMailTo,
} from "./helpers";

/**
 * THE PRIMARY ACCEPTANCE (spec "Testing Decisions" seam 1, ticket 11):
 * one browser drives signup → email verification THROUGH THE MAIL SINK →
 * workspace bootstrap → form creation → building blocks in the BUILDER UI →
 * publish → public submission through /f/{slug} → dashboard inbox review
 * (list + pinned-version detail).
 *
 * The accessibility seam rides along: axe scans (wcag2a + wcag2aa, failing
 * on serious/critical) on sign-in, the dashboard form list, the builder, the
 * inbox list + detail, and the public form — the public form additionally
 * at a 360px viewport with a no-horizontal-scroll assertion.
 *
 * The tests run SERIALLY and share server-side state (the account, the form,
 * the submission); a failure fails everything after it, which is exactly the
 * happy-path contract.
 */

test.describe.configure({ mode: "serial" });

const PASSWORD = "correct-horse-12";
const FORM_TITLE = "Client intake";
const WELCOME_TITLE = "Welcome aboard";
const SHORT_LABEL = "Full name";
const LONG_LABEL = "Tell us about your project";
const ENDING_TITLE = "Thank you!";
const SHORT_ANSWER = "Ada Lovelace";
// Creator/answer text with HTML-significant characters — the inbox MUST
// render it escaped as plain text, never as markup.
const LONG_ANSWER = 'Deck plans <script>alert(1)</script> & "quotes"';

/** Serial-run shared state (worker process only). */
const state: {
  email: string;
  formName: string;
  publicUrl: string;
  slug: string;
} = { email: "", formName: "", publicUrl: "", slug: "" };

async function openFormFromDashboard(page: Page): Promise<void> {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: state.formName }).click();
  await expect(page.getByRole("heading", { name: state.formName, level: 1 })).toBeVisible();
}

test("sign-in page passes the accessibility scan", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await assertNoSeriousAxeViolations(page, "sign-in");
});

test("signup → verification through the mail sink → bootstrap → dashboard", async ({ page }) => {
  test.setTimeout(180_000);
  state.email = uniqueEmail("e2e-inbox");

  await clearMailbox();
  await page.goto("/sign-up");
  await page.getByLabel("Name", { exact: true }).fill("E2E Owner");
  await page.getByLabel("Email", { exact: true }).fill(state.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();

  // Enumeration-safe success notice.
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

  // Read the verification link from the mail sink's REST mailbox API.
  const mail = await waitForMailTo(state.email);
  const verificationUrl = extractVerificationUrl(mail.raw);
  await page.goto(verificationUrl);

  // Sign in through the UI (verification itself already happened server-side).
  await signIn(page, state.email, PASSWORD);
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

  // First sign-in bootstraps the personal workspace in the browser.
  await expect(page.getByRole("button", { name: "New form" })).toBeVisible({
    timeout: 30_000,
  });

  // Dashboard form list (empty at this point) — accessibility scan.
  await assertNoSeriousAxeViolations(page, "dashboard form list");
});

test("create a form and add blocks through the builder UI", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, state.email, PASSWORD);
  await page.getByRole("button", { name: "New form" }).click();

  // The form page shell navigates straight into the builder.
  await expect(page.getByRole("heading", { name: "Blocks" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("status")).toHaveText("All changes saved");

  state.formName = await page.locator("h1").first().innerText();

  // Respondent-facing title (draft envelope).
  await page
    .getByLabel("Respondent-facing title", { exact: true })
    .fill(FORM_TITLE);

  const blocks = page.locator("ol > li");

  // Welcome block.
  await page.getByRole("button", { name: "Add welcome block" }).click();
  await blocks.nth(0).getByLabel("Title", { exact: true }).fill(WELCOME_TITLE);

  // Short text question (required).
  await page.getByRole("button", { name: "Add short text block" }).click();
  await blocks
    .nth(1)
    .getByLabel("Question label", { exact: true })
    .fill(SHORT_LABEL);
  await blocks.nth(1).getByLabel("Required", { exact: true }).check();

  // Long text question (optional).
  await page.getByRole("button", { name: "Add long text block" }).click();
  await blocks
    .nth(2)
    .getByLabel("Question label", { exact: true })
    .fill(LONG_LABEL);

  // Ending block.
  await page.getByRole("button", { name: "Add ending block" }).click();
  await blocks.nth(3).getByLabel("Title", { exact: true }).fill(ENDING_TITLE);

  // Every edit autosaves the FULL draft; wait until it is settled.
  await waitForDraftSettled(page);

  await assertNoSeriousAxeViolations(page, "builder");
});

test("publish allocates version 1 and the public link", async ({ page }) => {
  await openFormFromDashboard(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  await expect(page.getByText("Published version 1")).toBeVisible({
    timeout: 30_000,
  });

  const publicUrl = await page
    .getByRole("link", { name: "Open public page" })
    .getAttribute("href");
  expect(publicUrl).toBeTruthy();
  state.publicUrl = publicUrl!;
  state.slug = new URL(publicUrl!).pathname.split("/f/")[1]!;
  expect(state.slug).toMatch(/^[A-Za-z0-9]{10}$/);
});

test("public form at 360px: accessible, no horizontal scrolling", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(state.publicUrl);

  await expect(page.getByRole("heading", { name: FORM_TITLE, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  // The session must be active before the submit button enables — that also
  // proves the pinned-session flow works at 360px.
  await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled({
    timeout: 30_000,
  });

  await assertNoHorizontalScroll(page, 360);
  await assertNoSeriousAxeViolations(page, "public form (360px)");
});

test("public submission through the public UI stores the answers", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(state.publicUrl);
  await expect(page.getByRole("heading", { name: FORM_TITLE, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled({
    timeout: 30_000,
  });

  await page
    .getByLabel(`${SHORT_LABEL} (required)`, { exact: true })
    .fill(SHORT_ANSWER);
  await page
    .getByLabel(`${LONG_LABEL} (optional)`, { exact: true })
    .fill(LONG_ANSWER);
  await page.getByRole("button", { name: "Submit" }).click();

  // The receipt swaps the form for the ending block.
  const ended = page.getByTestId("public-form-ended");
  await expect(ended).toBeVisible({ timeout: 30_000 });
  await expect(ended.getByRole("heading", { name: ENDING_TITLE })).toBeVisible();
  await expect(ended.getByText("Your response has been received.")).toBeVisible();
});

test("inbox list shows the submission (received time + version)", async ({ page }) => {
  test.setTimeout(180_000);
  await openFormFromDashboard(page);
  await page.getByRole("link", { name: "View submissions" }).click();

  await expect(page.getByRole("heading", { name: "Submissions", level: 1 })).toBeVisible();
  const rows = page.getByTestId("inbox-row");
  await expect(rows).toHaveCount(1);

  const rowLink = rows.nth(0).getByRole("link");
  await expect(rowLink).toHaveText(/^Received \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  await expect(rows.nth(0).getByTestId("inbox-row-version")).toHaveText(
    "Form version 1",
  );

  await assertNoSeriousAxeViolations(page, "inbox list");
});

test("inbox detail pairs each answer with its pinned-version question", async ({ page }) => {
  test.setTimeout(180_000);
  await openFormFromDashboard(page);
  await page.getByRole("link", { name: "View submissions" }).click();
  await page.getByTestId("inbox-row").nth(0).getByRole("link").click();

  const detail = page.getByTestId("inbox-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("inbox-detail-version")).toHaveText("Form version 1");

  // Answer-beside-question pairs, in the PINNED schema's block order.
  const pairs = page.getByTestId("inbox-answer-pair");
  await expect(pairs).toHaveCount(2);
  await expect(pairs.nth(0).locator("dt")).toHaveText(SHORT_LABEL);
  await expect(pairs.nth(0).getByTestId("inbox-answer")).toHaveText(SHORT_ANSWER);
  await expect(pairs.nth(1).locator("dt")).toHaveText(LONG_LABEL);
  await expect(pairs.nth(1).getByTestId("inbox-answer")).toHaveText(LONG_ANSWER);

  // Escaped plain text: the injected <script> never became markup.
  await expect(
    page.locator("script").filter({ hasText: "alert(1)" }),
  ).toHaveCount(0);

  await assertNoSeriousAxeViolations(page, "inbox detail");
});
