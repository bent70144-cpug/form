import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import { buildOpenApiDocument } from "@form/contracts";
import {
  createHealthModule,
  validateHealthResponse,
} from "./health";
import { ProblemHttpError, problemFromError } from "./problem-details";

export interface DatabaseCheck {
  (): Promise<boolean>;
}

export interface CreateAppOptions {
  checkDatabase: DatabaseCheck;
  logger: Logger;
}

export type AppHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  contentType = "application/json",
): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(JSON.stringify(body));
}

/**
 * Request dispatcher for the M0 API. Routes are explicit; every error path
 * renders an RFC 9457 problem body via the shared filter.
 */
export function createApp(options: CreateAppOptions): AppHandler {
  const health = createHealthModule({ checkDatabase: options.checkDatabase });

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal");
    try {
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const result = await health.getHealth();
        // Contract round-trip: throws if the shape drifts from @form/contracts.
        const body = validateHealthResponse({
          status: result.status,
          db: result.db,
        });
        sendJson(response, 200, { ...body, message: result.message });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/openapi.json") {
        sendJson(response, 200, buildOpenApiDocument());
        return;
      }

      throw new ProblemHttpError("not_found");
    } catch (error) {
      const { status, body } = problemFromError(error);
      if (status >= 500) {
        options.logger.error({ err: error }, "unhandled request failure");
      }
      sendJson(response, status, body, "application/problem+json");
    }
  };
}

/** Binds the dispatcher to a node:http server (wired in src/index.ts). */
export function createHttpServer(options: CreateAppOptions) {
  const handler = createApp(options);
  return createServer((request, response) => {
    void handler(request, response).catch((error) => {
      options.logger.error({ err: error }, "dispatcher failure");
      if (!response.headersSent) {
        const { status, body } = problemFromError(error);
        sendJson(response, status, body, "application/problem+json");
      } else {
        response.end();
      }
    });
  });
}
