declare module "../../../scripts/mail-sink.mjs" {
  /** Dev SMTP sink (Mailpit substitute) — see scripts/mail-sink.mjs. */
  export interface SinkMessage {
    id: number;
    from: string;
    to: string[];
    receivedAt: string;
    raw: string;
  }
  export interface MailSink {
    smtpPort: number;
    httpPort: number;
    messages(): SinkMessage[];
    start(): Promise<{ smtpPort?: number; httpPort?: number }>;
    stop(): Promise<void>;
  }
  export function createMailSink(options?: {
    smtpPort?: number;
    httpPort?: number;
  }): MailSink;
}
