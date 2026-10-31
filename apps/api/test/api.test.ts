import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ProblemHttpError, problemFromError } from "../src/problem-details";

/** Minimal pino-shaped logger double. */
const silentLogger = {
  info: () => undefined,
  error: () => undefined,
} as never;

/** Minimal node:http ServerResponse double. */
function makeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  const response = {
    writeHead(code: number, h: Record<string, string>) {
      statusCode = code;
      headers = h;
      return response;
    },
    end(payload?: string) {
      if (payload) chunks.push(payload);
    },
  };
  return {
    asServerResponse: () => response as never,
    status: () => statusCode,
    headers: () => headers,
    body: () => chunks.join(""),
  };
}

async function call(app: ReturnType<typeof createApp>, url: string) {
  const res = makeRes();
  await app({ method: "GET", url } as never, res.asServerResponse());
  return res;
}

describe("api", () => {
  it("GET /v1/health reports liveness and database reachability", async () => {
    const app = createApp({ checkDatabase: async () => true, logger: silentLogger });
    const res = await call(app, "/v1/health");
    expect(res.status()).toBe(200);
    const body = JSON.parse(res.body()) as { status: string; db: boolean };
    expect(body.status).toBe("ok");
    expect(body.db).toBe(true);
  });

  it("GET /v1/health reports db: false when the probe fails", async () => {
    const app = createApp({ checkDatabase: async () => false, logger: silentLogger });
    const res = await call(app, "/v1/health");
    const body = JSON.parse(res.body()) as { db: boolean; message: string };
    expect(body.db).toBe(false);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("GET /v1/openapi.json serves the generated document", async () => {
    const app = createApp({ checkDatabase: async () => true, logger: silentLogger });
    const res = await call(app, "/v1/openapi.json");
    const body = JSON.parse(res.body()) as { openapi: string };
    expect(body.openapi).toBe("3.1.0");
  });

  it("unknown routes render an RFC 9457 problem with a stable code", async () => {
    const app = createApp({ checkDatabase: async () => true, logger: silentLogger });
    const res = await call(app, "/v1/nope");
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toBe("application/problem+json");
    const problem = JSON.parse(res.body()) as Record<string, unknown>;
    expect(problem["code"]).toBe("not_found");
    expect(problem["status"]).toBe(404);
    expect(String(problem["type"])).toContain("/errors/");
  });

  it("maps ProblemHttpError codes to spec statuses", () => {
    expect(problemFromError(new ProblemHttpError("draft_conflict")).status).toBe(409);
    expect(problemFromError(new ProblemHttpError("rate_limited")).status).toBe(429);
    expect(problemFromError(new ProblemHttpError("validation_failed")).status).toBe(422);
  });
});
