import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { uuidv7 } from "@form/database";
import { t } from "@form/i18n";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../password";
import { authTables } from "./auth-schema";
import { resolveEmailProvider } from "./email/resolve";
import type { EmailProvider } from "./email/types";

/**
 * The DB-backed Better Auth instance mounted by apps/api under `/v1/auth/*`.
 *
 * Ticket 02 spike settings (recorded in docs/adr/0003-topology-spike.md):
 * - Drizzle adapter over the `auth` Postgres schema (schema qualification
 *   lives in the `pgSchema("auth")` table definitions — better-auth 1.7.14
 *   has no string `useSchema` option).
 * - UUID user IDs: `advanced.database.generateId: () => uuidv7()` (IDs stay
 *   stored in Better Auth's `text` columns but carry UUIDv7 values, so
 *   `app.user_id uuid` and every tenant policy compare one representation).
 *
 * Ticket 03 (auth core) settings:
 * - `emailAndPassword.autoSignIn: false` → Better Auth answers a duplicate
 *   signup with the SAME generic 200 `{ token: null, user }` body as a fresh
 *   signup (enumeration-safe; it even hashes the password to flatten timing)
 *   and a fresh signup creates NO session — the user signs in explicitly.
 * - Password policy 12–128 via the shared constants (packages/auth/password,
 *   reused by ticket 04's reset flow).
 * - Verification email goes through the configured `EmailProvider`
 *   (mail sink locally, Resend HTTPS in deployed environments — never a
 *   console/log adapter).
 * - Session: 7-day expiry with daily rolling refresh (Better Auth defaults,
 *   pinned explicitly), HttpOnly SameSite=Lax cookie, Secure when the origin
 *   is HTTPS (forced on in production), server-side revocable.
 * - `trustedOrigins` = APP_ORIGIN; the global Nest Origin guard uses the
 *   same value (spec: "Better Auth's trusted origins are set to the app
 *   origin").
 *
 * Ticket 04 (password reset) settings:
 * - `emailAndPassword.sendResetPassword` delivers the reset email through
 *   the SAME `EmailProvider` port (i18n-resolved subject/body; the token
 *   only ever appears inside the message, never in logs).
 * - `resetPasswordTokenExpiresIn: 3600` — the single-use reset token lives
 *   exactly one hour (spec: "A reset token is single-use and expires after
 *   one hour"). Better Auth stores it as a `reset-password:<token>`
 *   verification row and `consumeVerificationValue` deletes it on use, so a
 *   token cannot be redeemed twice.
 * - `revokeSessionsOnPasswordReset: true` — completing a reset deletes ALL
 *   of the user's sessions before the credential write (spec: "completing a
 *   reset revokes all existing sessions").
 * - The reset request endpoint answers the SAME generic 200 body whether or
 *   not the address exists (Better Auth hashes a dummy lookup on miss —
 *   enumeration-safe), so the UI can render one shared i18n key
 *   (`auth.enumerationSafeResponse`).
 */
export interface CreateAuthOptions {
  databaseUrl: string;
  /** Public web origin (e.g. http://localhost:3000) — also the trusted origin. */
  appOrigin: string;
  secret: string;
  /** Verification-email provider; defaults to `resolveEmailProvider(process.env)`. */
  emailProvider?: EmailProvider;
  /** Caller-owned pool (tests close it); default: internal pool from the URL. */
  pool?: Pool;
  /** Force the `Secure` cookie attribute (set for NODE_ENV=production). */
  secureCookies?: boolean;
}

/** Session lifetime: seven days, refreshed on activity at most once a day. */
export const SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60; // 604800
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60; // 86400

/**
 * Password-reset token lifetime: one hour, single-use (spec: "A reset token
 * is single-use and expires after one hour"). Better Auth stores the token
 * as a `reset-password:<token>` verification row with this expiry and
 * deletes the row on first redemption.
 */
export const RESET_TOKEN_EXPIRES_IN_SECONDS = 60 * 60; // 3600

export function createAuth(options: CreateAuthOptions) {
  const emailProvider =
    options.emailProvider ?? resolveEmailProvider(process.env);
  return betterAuth({
    // Runtime schema qualification lives in the pgSchema("auth") tables; the
    // adapter's `schemaName` option drives the CLI schema generator only.
    database: drizzleAdapter(drizzle(options.pool ?? options.databaseUrl), {
      provider: "pg",
      schema: authTables,
    }),
    secret: options.secret,
    baseURL: options.appOrigin,
    basePath: "/v1/auth",
    trustedOrigins: [options.appOrigin],
    emailAndPassword: {
      enabled: true,
      // Enumeration safety + no session on signup (see docblock). NOT
      // `requireEmailVerification` — unverified users MAY sign in; the
      // email-unverified boundary is enforced per route by the API guard.
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // Ticket 04: single-use reset token, one-hour expiry (spec-pinned
      // value; Better Auth's default happens to be the same 3600 s but the
      // contract must not drift silently).
      resetPasswordTokenExpiresIn: RESET_TOKEN_EXPIRES_IN_SECONDS,
      // Ticket 04: completing a reset revokes every session of the user.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) => {
        // The subject/body text is resolved from the i18n catalog; the URL
        // (which contains the reset token) is never logged.
        await emailProvider.sendPasswordResetEmail({
          to: user.email,
          subject: t("auth.email.resetSubject"),
          text: t("auth.email.resetBody", { name: user.name, url }),
          url,
          token,
          user: { id: user.id, email: user.email, name: user.name },
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        // The subject/body text is resolved from the i18n catalog; the URL
        // (which contains the verification token) is never logged.
        await emailProvider.sendVerificationEmail({
          to: user.email,
          subject: t("auth.email.verificationSubject"),
          text: t("auth.email.verificationBody", { name: user.name, url }),
          url,
          user: { id: user.id, email: user.email, name: user.name },
        });
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      storeSessionInDatabase: true,
    },
    advanced: {
      database: {
        generateId: () => uuidv7(),
      },
      ...(options.secureCookies !== undefined ? { useSecureCookies: options.secureCookies } : {}),
    },
    rateLimit: {
      // The NestJS limiter (trusted-proxy aware) arrives in ticket 04; keep
      // Better Auth's built-in limiter off so the hop is deterministic.
      enabled: false,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Minimal shape of Better Auth's internal auth context we rely on here. */
interface AuthInternalContext {
  internalAdapter: {
    deleteSession(token: string): Promise<unknown>;
    findSession(token: string): Promise<{ session: unknown } | null>;
  };
}

/**
 * Server-side session revocation (spec: "seven-day rolling expiry and
 * server-side revocation"). Deletes the session row by token WITHOUT
 * requiring the holder's cookie — used by moderation/worker flows and the
 * revocation test. The next request bearing the revoked cookie fails
 * authentication.
 */
export async function revokeSessionByToken(
  auth: Auth,
  token: string,
): Promise<boolean> {
  const context = (await (auth as unknown as { $context: Promise<AuthInternalContext> }).$context);
  const existing = await context.internalAdapter.findSession(token);
  if (!existing) return false;
  await context.internalAdapter.deleteSession(token);
  return true;
}

/** Metadata describing the mount point (used by the API auth module). */
export const AUTH_MOUNT = {
  /** Path prefix inside the API where Better Auth is mounted. */
  basePath: "/v1/auth",
  /**
   * Paths under the mount the API handles in Nest instead of Better Auth
   * (the mount falls through to `next()` for them).
   */
  nestHandledPaths: ["/v1/auth/session"],
} as const;

/** Email provider port + adapters are part of the server surface. */
export * from "./email/types";
export * from "./email/resolve";
