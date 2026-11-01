import { Controller, Get, Inject } from "@nestjs/common";
import type { TrustedIpConfig } from "./common/trusted-ip";
import { deriveClientIp } from "./common/trusted-ip";
import type { Pool } from "pg";
import type { Request, Response, NextFunction } from "express";
import { APP_DB_POOL } from "./db/app-db";

/** How long the health probe waits for the database before reporting `db:false`. */
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * One database-reachability probe: a bare `SELECT 1` on the pooled app_user
 * connection, raced against a fixed timeout. No tenant table is touched and
 * no parameter is sent, so the probe cannot expose tenant data. Any failure —
 * connection error, timeout — degrades to `false`; the error text is
 * deliberately DISCARDED (pg errors can embed the connection string, which is
 * a secret) and the body stays exactly `{status, db}`.
 */
export async function probeDatabase(
  query: () => Promise<unknown>,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const probe = query();
    // The losing race must never surface as an unhandledRejection.
    probe.catch(() => undefined);
    await Promise.race([
      probe,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("health probe timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Health endpoint (spec: "A health endpoint reports process liveness and
 * database reachability without exposing tenant data").
 *
 * Liveness = the HTTP 200 itself (the deployment platform's health check);
 * database reachability = the `db` boolean (contracts healthResponseSchema),
 * measured live against the pooled app_user connection on every request —
 * a static value would claim reachability it never verified.
 */
@Controller("health")
export class HealthController {
  constructor(@Inject(APP_DB_POOL) private readonly dbPool: Pool) {}

  @Get()
  async health(): Promise<{ status: "ok"; db: boolean }> {
    return { status: "ok", db: await probeDatabase(() => this.dbPool.query("SELECT 1")) };
  }
}

/**
 * Ticket 04 hop diagnostics — replaces the ADR-0003 spike recorder
 * (`x-spike-*`, removed as planned). In NON-PRODUCTION only, responses carry
 * what the trusted-proxy derivation actually used, so the real
 * browser → Next.js `/v1/*` rewrite → NestJS hop test can assert the derived
 * client IP and the forwarded chain NestJS received:
 *
 * - `x-hop-peer-address` — the raw socket peer (the Next process locally).
 * - `x-hop-forwarded-for` — the received `x-forwarded-for` header verbatim.
 * - `x-derived-client-ip` — what `deriveClientIp` keyed rate limits with.
 *
 * Production sends NONE of these (they are a diagnostic surface, not a
 * contract; the security property — spoofed headers cannot change the
 * derived IP — is covered by unit and rewrite-hop tests).
 */
export function hopDiagnostics(trustedIpConfig: TrustedIpConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === "production") {
      next();
      return;
    }
    res.setHeader("x-hop-peer-address", req.socket.remoteAddress ?? "unknown");
    const forwardedFor = req.headers["x-forwarded-for"];
    if (forwardedFor !== undefined) {
      res.setHeader("x-hop-forwarded-for", String(forwardedFor));
    }
    const derived = deriveClientIp(req, trustedIpConfig);
    if (derived !== null) {
      res.setHeader("x-derived-client-ip", derived);
    }
    next();
  };
}
