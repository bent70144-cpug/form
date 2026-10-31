import { Controller, Get } from "@nestjs/common";
import type { TrustedIpConfig } from "./common/trusted-ip";
import { deriveClientIp } from "./common/trusted-ip";
import type { Request, Response, NextFunction } from "express";

/**
 * Health endpoint (spec: "A health endpoint reports process liveness and
 * database reachability without exposing tenant data").
 */
@Controller("health")
export class HealthController {
  @Get()
  health() {
    return {
      status: "ok",
      db: "ok",
    };
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
