import { t } from "@form/i18n";
import { sendMailViaSmtp } from "./smtp-client";
import type {
  EmailProvider,
  PasswordResetEmailInput,
  VerificationEmailInput,
} from "./types";

/**
 * DEV adapter: delivers verification and password-reset email over raw SMTP
 * to the local mail sink (the decided Mailpit substitute —
 * scripts/mail-sink.mjs, SMTP on 127.0.0.1:1025, mailbox API GET
 * http://127.0.0.1:5434/dev/mailbox).
 *
 * Only usable in local development/tests; `resolveEmailProvider` never picks
 * it for production unless explicitly configured with EMAIL_PROVIDER.
 */
export interface MailSinkProviderOptions {
  host?: string;
  port?: number;
  from?: string;
}

export class MailSinkEmailProvider implements EmailProvider {
  readonly name = "mail_sink";

  constructor(private readonly options: MailSinkProviderOptions = {}) {}

  async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
    await sendMailViaSmtp({
      host: this.options.host ?? "127.0.0.1",
      port: this.options.port ?? 1025,
      from: this.options.from ?? "Form <no-reply@localhost.test>",
      to: input.to,
      subject: input.subject || t("auth.email.verificationSubject"),
      text: input.text,
    });
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    await sendMailViaSmtp({
      host: this.options.host ?? "127.0.0.1",
      port: this.options.port ?? 1025,
      from: this.options.from ?? "Form <no-reply@localhost.test>",
      to: input.to,
      subject: input.subject || t("auth.email.resetSubject"),
      text: input.text,
    });
  }
}
