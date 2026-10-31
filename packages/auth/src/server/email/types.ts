/**
 * Email provider port (spec: "Verification email uses Mailpit locally and a
 * real HTTPS email API in deployed environments; the HTTPS adapter is wired
 * in the auth-core slice").
 *
 * Implementations in this package:
 * - `MailSinkEmailProvider` — dev adapter delivering over raw SMTP to the
 *   local mail sink (the decided Mailpit substitute, scripts/mail-sink.mjs).
 * - `ResendEmailProvider`   — deployed adapter posting to Resend's HTTPS API;
 *   throws `EmailProviderNotConfiguredError` unless RESEND_API_KEY exists.
 *
 * There is deliberately NO console/log adapter: in deployed environments a
 * misconfigured provider must fail loudly instead of leaking verification
 * links into logs (spec: "no verification token appears in logs").
 */
export interface VerificationEmailInput {
  /** Recipient (the freshly signed-up user's address). */
  to: string;
  /** Subject line, resolved from the i18n catalog by the caller. */
  subject: string;
  /** Plain-text body. Contains the verification link built by Better Auth. */
  text: string;
  /**
   * The verification URL handed over by Better Auth. Implementations embed
   * it verbatim in the message body and must NEVER log it.
   */
  url: string;
  user: { id: string; email: string; name: string };
}

export interface EmailProvider {
  /** Stable adapter name (used in logs/metrics; never the token). */
  readonly name: string;
  sendVerificationEmail(input: VerificationEmailInput): Promise<void>;
}

/** Thrown when a deployed provider is selected but its credentials are absent. */
export class EmailProviderNotConfiguredError extends Error {
  constructor(message = "Email provider is not configured") {
    super(message);
    this.name = "EmailProviderNotConfiguredError";
  }
}
