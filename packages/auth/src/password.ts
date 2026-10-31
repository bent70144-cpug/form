/**
 * Shared password policy (spec: "Passwords are 12–128 characters").
 *
 * Single source of truth shared with ticket 04 (password reset enforces the
 * same limits). The Better Auth instance reads these for
 * `emailAndPassword.minPasswordLength` / `maxPasswordLength`; the web signup
 * form and the reset flow read them for client-side checks. The *message*
 * itself comes from the i18n package (`auth.errors.passwordPolicy`).
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_LIMITS = {
  min: PASSWORD_MIN_LENGTH,
  max: PASSWORD_MAX_LENGTH,
} as const;

/** True when `password` satisfies the M0 length policy (no content rules). */
export function isValidPasswordLength(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH
  );
}
