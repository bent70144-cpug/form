import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Structured logger (pino) shared by API and worker.
 *
 * Spec guardrail: "Structured logs redact cookies, auth tokens, authorization
 * headers, and tenant payloads; a logged request never contains a reusable
 * credential." The redact list below is the single source of truth and is
 * covered by a unit test so a refactor cannot silently drop it.
 */
export const REDACT_PATHS: string[] = [
  // request-shaped locations (pino-http style payloads and custom serializers)
  "req.headers.cookie",
  "req.headers.authorization",
  "req.headers['x-form-session']",
  "headers.cookie",
  "headers.authorization",
  "headers['x-form-session']",
  // flat and one-level-deep generic locations
  "cookie",
  "authorization",
  "set-cookie",
  "password",
  "token",
  "authToken",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "secret",
  "*.cookie",
  "*.authorization",
  "*.set-cookie",
  "*.password",
  "*.token",
  "*.authToken",
  "*.accessToken",
  "*.refreshToken",
  "*.sessionToken",
  "*.secret",
  "*.headers.cookie",
  "*.headers.authorization",
];

export const REDACTED_PLACEHOLDER = "[REDACTED]";

export function createLogger(options: {
  name: string;
  level?: string;
  destination?: pino.DestinationStream;
}): Logger {
  const loggerOptions: LoggerOptions = {
    name: options.name,
    level: options.level ?? "info",
    redact: {
      paths: REDACT_PATHS,
      censor: REDACTED_PLACEHOLDER,
    },
    base: { service: options.name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };
  const stream = options.destination;
  return stream ? pino(loggerOptions, stream) : pino(loggerOptions);
}
