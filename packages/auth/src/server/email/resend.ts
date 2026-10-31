import { EmailProviderNotConfiguredError } from "./types";
import type { EmailProvider, VerificationEmailInput } from "./types";

/**
 * DEPLOYED adapter: Resend HTTPS API (https://resend.com/docs/api-reference).
 *
 * Spec requirements wired here:
 * - "a real HTTPS email API in deployed environments" — sends via `fetch`
 *   (no SMTP, works on Render's free tier with only outbound HTTPS).
 * - "No console email adapter is used in deployed environments" — there is
 *   no fallback: without RESEND_API_KEY every send throws
 *   `EmailProviderNotConfiguredError`, which surfaces as a failed
 *   verification-email send (Better Auth logs the failure WITHOUT the token).
 * - Sending-domain prerequisite: before the first outside tester, a sending
 *   domain must be owned and verified with the provider (roughly $10/year —
 *   confirm current pricing); the `onrender.com` hostname cannot be verified
 *   as a sender domain. Configure EMAIL_FROM with an address on the verified
 *   domain. See docs/runbooks (requires credentials).
 *
 * The provider's sandbox may deliver only to the account owner's address
 * during development — that is expected behavior of the provider, not a
 * limitation of this adapter.
 */
export interface ResendProviderOptions {
  /** RESEND_API_KEY — absent → `sendVerificationEmail` throws. */
  apiKey?: string;
  from?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to the public Resend API. */
  endpoint?: string;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  constructor(private readonly options: ResendProviderOptions = {}) {}

  async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
    if (!this.options.apiKey) {
      throw new EmailProviderNotConfiguredError(
        "Resend email provider is not configured: set EMAIL_PROVIDER=resend and RESEND_API_KEY (server-side only). Before the first outside tester, own and verify a sending domain — the onrender.com hostname cannot be a verified sender.",
      );
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(this.options.endpoint ?? "https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.options.from ?? "Form <no-reply@localhost.test>",
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!response.ok) {
      // Deliberately does not include the request body (which contains the
      // verification link) in the error message.
      throw new Error(`Resend email provider failed with status ${response.status}`);
    }
  }
}
