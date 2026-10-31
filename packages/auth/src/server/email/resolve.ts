import { MailSinkEmailProvider } from "./mail-sink";
import { ResendEmailProvider } from "./resend";
import type { EmailProvider } from "./types";

/**
 * Chooses the email provider from the environment (Zod-validated upstream in
 * apps/api; this resolver stays dependency-light and pure).
 *
 * - `EMAIL_PROVIDER=mail_sink` → dev SMTP sink adapter.
 * - `EMAIL_PROVIDER=resend`    → Resend HTTPS adapter (throws on send when
 *   RESEND_API_KEY is absent).
 * - unset → development/test default to the mail sink; production defaults
 *   to Resend. There is NO console adapter in any mode — an unconfigured
 *   deployed environment fails verification-email sends loudly instead of
 *   leaking tokens into logs.
 */
export interface EmailProviderEnv {
  NODE_ENV?: string;
  EMAIL_PROVIDER?: "mail_sink" | "resend";
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: number | string;
  EMAIL_FROM?: string;
}

export function resolveEmailProvider(env: EmailProviderEnv = {}): EmailProvider {
  const selected = env.EMAIL_PROVIDER ?? (env.NODE_ENV === "production" ? "resend" : "mail_sink");
  switch (selected) {
    case "mail_sink":
      return new MailSinkEmailProvider({
        host: env.SMTP_HOST ?? "127.0.0.1",
        port: typeof env.SMTP_PORT === "string" ? Number(env.SMTP_PORT) : (env.SMTP_PORT ?? 1025),
        from: env.EMAIL_FROM,
      });
    case "resend":
      return new ResendEmailProvider({
        apiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM,
      });
    default: {
      const exhaustive: never = selected;
      throw new Error(`Unknown EMAIL_PROVIDER: ${String(exhaustive)}`);
    }
  }
}

export { MailSinkEmailProvider, ResendEmailProvider };
export { EmailProviderNotConfiguredError } from "./types";
export { sendMailViaSmtp } from "./smtp-client";
