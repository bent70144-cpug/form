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
      "The M0 dashboard is a placeholder. Workspaces and forms arrive in the next slices.",
    settingUpWorkspace: "Setting up your workspace…",
    bootstrapFailed:
      "Setting up your workspace failed. Reload the page to try again.",
    signedInAs: "Signed in as {email}",
    workspace: {
      label: "Workspace",
    },
    bootstrap: {
      settingUp: "Setting up your workspace…",
      failed:
        "Setting up your workspace failed. Please try again.",
      retry: "Retry",
    },
    signOut: "Sign out",
    forms: {
      title: "Forms",
      newForm: "New form",
      creating: "Creating…",
      createFailed: "Creating the form failed. Please try again.",
      empty: "No forms yet. Create your first form to get started.",
      open: "Open",
      createdAt: "Created {date}",
      rename: "Rename",
      renameLabel: "New name",
      saving: "Saving…",
      renameFailed: "Renaming failed. Please try again.",
      backToDashboard: "Back to dashboard",
      draftLabel: "Draft",
      draftVersion: "Draft version {version}",
      untitled: "Untitled form",
      blocksHeading: "Blocks",
      blocksEmpty: "This form has no blocks yet.",
      block: {
        welcome: "Welcome",
        shortText: "Short text",
        longText: "Long text",
        ending: "Ending",
      },
      question: {
        required: "Required",
        optional: "Optional",
      },
    },
  },
  auth: {
    signIn: {
      title: "Sign in",
      emailLabel: "Email",
      passwordLabel: "Password",
      submit: "Sign in",
      noAccount: "Don't have an account?",
      switchToSignUp: "Create one",
    },
    signUp: {
      title: "Create your account",
      nameLabel: "Name",
      emailLabel: "Email",
      passwordLabel: "Password",
      submit: "Sign up",
      haveAccount: "Already have an account?",
      switchToSignIn: "Sign in",
      checkInboxTitle: "Check your inbox",
      checkInboxBody:
        "We sent a verification link to {email}. Open it to activate your account.",
    },
    passwordPolicyHint: "Use {min}–{max} characters.",
    /**
     * THE shared enumeration-safe response (ticket 04: enumeration-safe
     * responses share ONE key). Rendered identically no matter whether the
     * address exists: the sign-up "check your inbox" notice and the
     * forgot-password confirmation both resolve THIS key — never a message
     * that could confirm or deny account existence.
     */
    enumerationSafeResponse:
      "If an account exists for {email}, we have sent it an email. Please check your inbox.",
    forgotPassword: {
      title: "Forgot your password?",
      emailLabel: "Email",
      submit: "Send reset link",
      backToSignIn: "Back to sign in",
    },
    resetPassword: {
      title: "Choose a new password",
      newPasswordLabel: "New password",
      submit: "Reset password",
      success: "Your password has been reset. Sign in with the new password.",
      invalidToken: "This reset link is invalid, already used, or expired. Request a new one.",
      backToSignIn: "Back to sign in",
    },
    verifyEmail: {
      title: "Email verification",
      success: "Your email is verified. You can sign in now.",
      failed: "The verification link is invalid or has expired.",
      resendHere: "You can request a new link after signing in.",
      backToSignIn: "Back to sign in",
    },
    resend: {
      prompt: "Your email is not verified yet.",
      action: "Resend verification email",
      sent: "Verification email sent. Check your inbox.",
    },
    signOut: {
      action: "Sign out",
    },
    email: {
      verificationSubject: "Verify your email",
      verificationBody:
        "Hi {name},\n\nOpen this link to verify your email for your Form account:\n\n{url}\n\nIf you didn't create an account, you can ignore this message.",
      resetSubject: "Reset your password",
      resetBody:
        "Hi {name},\n\nOpen this link to choose a new password for your Form account:\n\n{url}\n\nThe link works once and expires after one hour. If you didn't request a reset, you can ignore this message.",
    },
    errors: {
      invalidCredentials: "Invalid email or password.",
      emailUnverified: "Verify your email before using workspace features.",
      generic: "Something went wrong. Please try again.",
      passwordPolicy: "Password must be {min}–{max} characters.",
    },
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
    emailUnverified: {
      title: "Email not verified",
      detail: "Verify your email address before accessing this resource.",
    },
    originMismatch: {
      title: "Origin check failed",
      detail: "Requests that change state must come from the application origin.",
    },
    workspaceSetup: {
      title: "Workspace not set up",
      detail:
        "No active workspace yet. Call POST /v1/workspaces/bootstrap to create your personal workspace.",
    },
  },
} as const;

export type Catalog = typeof en;
