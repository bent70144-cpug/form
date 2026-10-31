import type { Request, Response, NextFunction } from "express";
import { toNodeHandler } from "better-auth/node";
import { AUTH_MOUNT, type Auth } from "@form/auth/server";

/** Path prefix inside the API where Better Auth is mounted (shared const). */
export const AUTH_BASE_PATH: string = AUTH_MOUNT.basePath;

/** Paths served by Nest controllers even though they sit under the mount. */
const NEST_HANDLED = new Set<string>(AUTH_MOUNT.nestHandledPaths);

/**
 * Express middleware mounting Better Auth WITHOUT stripping the prefix —
 * Express `app.use('/v1/auth', handler)` would rewrite `req.url` to
 * `/sign-up/email` and break Better Auth's `basePath: '/v1/auth'` matching.
 * The handler receives the full original URL so the mount point stays honest.
 *
 * `GET /v1/auth/session` falls through to the Nest router (SessionController)
 * so the API owns the minimal session contract instead of Better Auth's
 * full payload — see AUTH_MOUNT.nestHandledPaths.
 */
export function mountBetterAuth(auth: Auth) {
  const handler = toNodeHandler(auth);
  return (req: Request, res: Response, next: NextFunction) => {
    const url = req.originalUrl ?? req.url;
    if (url === AUTH_BASE_PATH || url.startsWith(`${AUTH_BASE_PATH}/`)) {
      const pathname = url.split("?")[0] ?? url;
      if (NEST_HANDLED.has(pathname)) {
        next();
        return;
      }
      void handler(req, res);
      return;
    }
    next();
  };
}
