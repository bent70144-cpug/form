import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Injectable, Inject } from "@nestjs/common";
import type { Pool } from "pg";
import {
  PUBLIC_SESSION_PER_HOUR_PER_FORM,
  PUBLIC_SESSION_PER_HOUR_PER_IP,
  keyFor,
  RateLimiter,
} from "../common/rate-limit";
import { deriveClientIp, type TrustedIpConfig } from "../common/trusted-ip";
import { APP_DB_POOL } from "../db/app-db";
import { uuidv7 } from "@form/database";
import { withPublicTransaction } from "./public-transaction";

/**
 * Public session service (ticket 10) — `POST /v1/public/forms/{slug}/sessions`,
 * the session-creation half of the interactive public form.
 *
 * Spec contract:
 * - UNauthenticated and cookie-less: the handler never reads the auth cookie
 *   and is on the explicit Origin-exempt allowlist (common/origin-guard.ts).
 * - The form resolves through the security-definer `resolve_public_form(slug)`
 *   — only PUBLISHED, non-deleted forms with a current slug resolve; anything
 *   else is 404 (`resolve_public_form` is the session-creation function,
 *   DISTINCT from the render-only `get_published_form`).
 * - The raw token (32 random bytes, base64url) is returned ONCE; only its
 *   SHA-256 hash is stored. The session PINS the currently published version
 *   for 24 hours (`expires_at = now() + 24h`).
 * - Stored IP metadata is an HMAC-SHA256 of the trusted-proxy client IP with
 *   a server secret (IP_HASH_SECRET, falling back to key material derived
 *   from BETTER_AUTH_SECRET in dev/test) — never a reversible hash.
 * - Rate-limited 30/hour per trusted client IP AND per form (ADR-0004
 *   limiter; spoofed forwarded headers cannot change the derived IP).
 * - `app.workspace_id` is set from the RESOLVED form inside the insert
 *   transaction — a forged workspace header can never influence it.
 */

/** Response contract shape (packages/contracts sessionCreateResponseSchema). */
export interface PublicSessionRow {
  token: string;
  expiresAt: Date;
  pinnedVersionId: string;
  schema: unknown;
}

export interface CreateSessionRequestContext {
  /** Headers object of the incoming request (for the trusted IP walk). */
  headers: Record<string, string | string[] | undefined>;
  /** Socket peer address (the trusted chain's first hop). */
  remoteAddress: string | undefined;
  /** Raw User-Agent header value (stored, length-capped). */
  userAgent: string | undefined;
}

const USER_AGENT_MAX_CHARS = 512;

@Injectable()
export class PublicSessionService {
  constructor(
    @Inject(APP_DB_POOL) private readonly pool: Pool,
    // Explicit @Inject (codebase convention, see email-verified.guard.ts):
    // tsx/esbuild emits no `design:paramtypes`, so a self-declared dep is
    // `undefined` at runtime there — explicit tokens work in every pipeline.
    @Inject(RateLimiter)
    private readonly limiter: RateLimiter,
    @Inject("PUBLIC_TRUSTED_IP_CONFIG") private readonly trustedIpConfig: TrustedIpConfig,
    @Inject("PUBLIC_IP_HASH_SECRET") private readonly ipHashSecret: string,
  ) {}

  /** HMAC-SHA256 of the client IP with the server secret (hex, 64 chars). */
  hashIp(clientIp: string): string {
    return createHmac("sha256", this.ipHashSecret).update(clientIp).digest("hex");
  }

  /**
   * Rate-limits (30/hour per IP and per form) then creates the pinned
   * session. Returns `null` when the slug does not resolve to a published
   * form (→ 404 at the controller) and `"rate_limited"` when either bucket
   * is exhausted (→ 429 with Retry-After).
   */
  async createSession(
    slug: string,
    ctx: CreateSessionRequestContext,
  ): Promise<
    | { ok: true; session: PublicSessionRow }
    | { ok: false; reason: "not_found" | "rate_limited"; retryAfterSec?: number }
  > {
    // Resolve through the security-definer seam FIRST: the per-form bucket
    // needs the form id, and unresolvable slugs answer 404 without consuming
    // a rate-limit slot.
    const resolved = await this.pool.query<{ result: unknown }>(
      `SELECT app.resolve_public_form($1) AS result`,
      [slug],
    );
    const raw = resolved.rows[0]?.result as
      | {
          formId: string;
          workspaceId: string;
          versionId: string;
          schema: unknown;
        }
      | null;
    if (!raw) return { ok: false, reason: "not_found" };

    const clientIp =
      deriveClientIp(
        { socket: { remoteAddress: ctx.remoteAddress }, headers: ctx.headers },
        this.trustedIpConfig,
      ) ?? "unknown";

    // Two independent buckets (spec): per IP and per form. Both must pass.
    const byIp = this.limiter.check(
      keyFor(["public-session", "ip", clientIp]),
      PUBLIC_SESSION_PER_HOUR_PER_IP.limit,
      PUBLIC_SESSION_PER_HOUR_PER_IP.windowMs,
    );
    if (!byIp.ok) {
      return { ok: false, reason: "rate_limited", retryAfterSec: byIp.retryAfterSec };
    }
    const byForm = this.limiter.check(
      keyFor(["public-session", "form", raw.formId]),
      PUBLIC_SESSION_PER_HOUR_PER_FORM.limit,
      PUBLIC_SESSION_PER_HOUR_PER_FORM.windowMs,
    );
    if (!byForm.ok) {
      return { ok: false, reason: "rate_limited", retryAfterSec: byForm.retryAfterSec };
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const ipHash = this.hashIp(clientIp);
    const userAgent = (ctx.userAgent ?? "").slice(0, USER_AGENT_MAX_CHARS);

    const inserted = await withPublicTransaction(
      this.pool,
      raw.workspaceId,
      async (tx) =>
        tx.query<{ id: string; expires_at: Date }>(
          `INSERT INTO app.form_sessions
             (id, workspace_id, form_id, form_version_id, token_hash,
              expires_at, ip_hash, user_agent)
           VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours', $6, $7)
           RETURNING id::text, expires_at`,
          [
            uuidv7(),
            raw.workspaceId,
            raw.formId,
            raw.versionId,
            tokenHash,
            ipHash,
            userAgent,
          ],
        ),
    );

    const row = inserted.rows[0]!;
    return {
      ok: true,
      session: {
        token,
        expiresAt: row.expires_at,
        pinnedVersionId: raw.versionId,
        schema: raw.schema,
      },
    };
  }
}

/**
 * Constant-time comparison of a raw session token against a stored hash —
 * used by the submit path to keep the token check timing-insensitive at the
 * application seam too (the DB unique index on token_hash is the primary
 * lookup; this helper exists for tests and future out-of-band checks).
 */
export function tokenHashMatches(token: string, expectedHashHex: string): boolean {
  const actual = createHash("sha256").update(token).digest("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expectedHashHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
