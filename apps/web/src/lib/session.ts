import { cache } from "react";
import { cookies } from "next/headers";
import { createSessionClient } from "@form/auth/client";
import { internalApiUrl } from "./internal-api";

/**
 * Server-component session validation (spec: "Next.js server components
 * validate the session by calling GET /v1/auth/session on the internal API
 * URL with the incoming cookie forwarded. The call is wrapped in React's
 * cache() so multiple components on one render share one request").
 *
 * Wrapped in `cache()` — one HTTP call per render even if several components
 * ask for the session. Returns null for signed-out/invalid/revoked sessions
 * (the endpoint answers 401 with an empty body). A session revoked
 * server-side between renders redirects on the next request (dashboard).
 */
export const getServerSession = cache(async () => {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const client = createSessionClient({ baseUrl: internalApiUrl() });
  return client.getSession(cookieHeader || undefined);
});
