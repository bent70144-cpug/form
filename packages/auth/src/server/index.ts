/**
 * @form/auth/server — mounting point for the DB-backed Better Auth instance.
 *
 * IMPORT GUARD: this entrypoint may only be imported by the API app
 * (apps/api). It is blocked by:
 *   - `no-restricted-imports` in the web app ESLint config,
 *   - the package-level rule in packages/config/eslint (no package may import
 *     it),
 *   - the web build-time check script (apps/web/scripts/check-imports.mjs).
 *
 * The real Better Auth instance (email/password, verification, reset, session
 * storage in the `auth` Postgres schema) is wired in tickets 02/03. Until then
 * this stub exposes the exact mounting contract the API will use, so the
 * package boundary and import guards exist and are exercised now.
 */

export interface AuthRequestLike {
  url?: string;
  headers: { get(name: string): string | null };
}

export interface AuthResponseLike {
  status: (code: number) => AuthResponseLike;
  body: (payload: unknown) => AuthResponseLike;
}

export type AuthHandler = (
  request: AuthRequestLike,
  response: AuthResponseLike,
) => Promise<void>;

export class AuthNotImplementedError extends Error {
  constructor() {
    super(
      "Better Auth is not wired yet: @form/auth/server is a mounting stub until tickets 02/03.",
    );
    this.name = "AuthNotImplementedError";
  }
}

/**
 * Returns the handler the API mounts under `/v1/auth/*`. M0 stub: always
 * fails with AuthNotImplementedError. Ticket 03 replaces the body with the
 * real Better Auth handler; the call sites do not change.
 */
export function createAuthHandler(): AuthHandler {
  return async () => {
    throw new AuthNotImplementedError();
  };
}

/** Metadata describing the mount point (used by the API auth module). */
export const AUTH_MOUNT = {
  /** Path prefix inside the API where Better Auth is mounted. */
  basePath: "/v1/auth",
  /** Cookie-less allowlist exemptions are defined by the spec, not here. */
  notes:
    "Mounted by apps/api under /v1/auth/*; browser reaches it through the same-origin Next.js /v1/* rewrite.",
} as const;
