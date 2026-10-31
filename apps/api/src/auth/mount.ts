import type { Request, Response, NextFunction } from "express";
import { toNodeHandler } from "better-auth/node";
import type { Auth } from "./auth";

/** Path prefix inside the API where Better Auth is mounted. */
export const AUTH_BASE_PATH = "/v1/auth";

/**
 * Express middleware mounting Better Auth WITHOUT stripping the prefix —
 * Express `app.use('/v1/auth', handler)` would rewrite `req.url` to
 * `/sign-up/email` and break Better Auth's `basePath: '/v1/auth'` matching.
 * The handler receives the full original URL so the mount point stays honest.
 */
export function mountBetterAuth(auth: Auth) {
  const handler = toNodeHandler(auth);
  return (req: Request, res: Response, next: NextFunction) => {
    const url = req.originalUrl ?? req.url;
    if (url === AUTH_BASE_PATH || url.startsWith(`${AUTH_BASE_PATH}/`)) {
      void handler(req, res);
      return;
    }
    next();
  };
}
