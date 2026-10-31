import { Controller, Get } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";

/**
 * Health endpoint (spec: "A health endpoint reports process liveness and
 * database reachability without exposing tenant data").
 *
 * The spike-debug headers record what NestJS actually sees behind the
 * Next.js /v1/* rewrite (peer address + forwarded chain). Ticket 04 replaces
 * this instrumentation with the trusted-proxy derivation; the headers are
 * marked spike-only and must not be relied upon.
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
 * Spike middleware recording the hop Nest sees. REMOVED at ticket 04 when the
 * trusted-proxy chain lands.
 */
export function spikeHopRecorder(req: Request, res: Response, next: NextFunction) {
  res.setHeader("x-spike-peer-address", req.socket.remoteAddress ?? "unknown");
  const forwarded = ["forwarded", "x-forwarded-for", "x-real-ip"]
    .map((h) => [h, req.headers[h]])
    .filter(([, v]) => v !== undefined);
  if (forwarded.length > 0) {
    res.setHeader("x-spike-forwarded-headers", JSON.stringify(Object.fromEntries(forwarded)));
  }
  next();
}
