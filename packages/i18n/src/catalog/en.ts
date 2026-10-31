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
    signedInAs: "Signed in as {email}",
    signOut: "Sign out",
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
  },
} as const;

export type Catalog = typeof en;
