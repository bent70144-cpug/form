import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { en } from "@form/i18n";

/**
 * Web entrypoint server (M0 placeholder).
 *
 * Ticket 01 scope: a runnable web entrypoint with the two seams later slices
 * build on —
 *   1. server-rendered pages using @form/i18n keys (never hardcoded strings),
 *   2. the same-origin `/v1/*` proxy to the internal API, which is what the
 *      Next.js `rewrites()` config replaces when Next.js is wired (ticket 02,
 *      "Next.js rewrites /v1/* to NestJS").
 *
 * The browser deployable never imports @form/database or @form/auth/server;
 * that boundary is enforced by ESLint (apps/web/eslint.config.mjs) and by
 * scripts/check-imports.mjs at build time.
 */
export interface WebServerOptions {
  /** Internal API base, e.g. http://127.0.0.1:4000. */
  apiInternalUrl: string;
}

function renderHome(): string {
  const title = en.home.title;
  const subtitle = en.home.subtitle;
  const appName = en.common.appName;
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${appName}</title></head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${subtitle}</p>
    </main>
  </body>
</html>`;
}

function proxy(
  targetBase: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const target = new URL(request.url ?? "/", targetBase);
  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: { ...request.headers, host: target.host },
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ type: "about:blank", title: "Bad Gateway", status: 502 }));
  });
  request.pipe(upstream);
}

export function createWebServer(options: WebServerOptions) {
  const apiBase = options.apiInternalUrl.replace(/\/$/, "");
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://public");
    if (url.pathname === "/v1/" || url.pathname.startsWith("/v1/")) {
      // Same-origin rewrite seam: /v1/* goes to the internal API.
      proxy(apiBase, request, response);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderHome());
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
}
