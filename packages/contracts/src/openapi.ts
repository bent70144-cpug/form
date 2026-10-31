import { zodToJsonSchema } from "zod-to-json-schema";
import { healthResponseSchema } from "./schemas/health";
import { problemDetailsSchema } from "./schemas/errors";

/**
 * OpenAPI 3.1 document generated from the shared Zod contracts (spec: "a
 * single OpenAPI description generated from the request and response schemas,
 * so the web client and future public API cannot drift"). Served at
 * `/v1/openapi.json` and snapshot-tested.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Form API",
      version: "0.1.0",
      description:
        "REST API under /v1. JSON, camelCase, ISO-8601 UTC timestamps. Errors use RFC 9457 Problem Details with a stable code.",
    },
    servers: [{ url: "/v1" }],
    tags: [
      { name: "operations", description: "Health and OpenAPI" },
    ],
    paths: {
      "/v1/health": {
        get: {
          operationId: "getHealth",
          tags: ["operations"],
          summary: "Liveness and database reachability",
          responses: {
            "200": {
              description: "Process is alive; `db` reports reachability",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(healthResponseSchema, {
                    target: "openapi-3.0",
                  }),
                },
              },
            },
            "500": {
              description: "Unexpected failure",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openapi-3.0",
                  }),
                },
              },
            },
          },
        },
      },
      "/v1/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          tags: ["operations"],
          summary: "This document",
          responses: {
            "200": {
              description: "OpenAPI 3.1 document",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        HealthResponse: zodToJsonSchema(healthResponseSchema, {
          target: "openapi-3.0",
        }),
        ProblemDetails: zodToJsonSchema(problemDetailsSchema, {
          target: "openapi-3.0",
        }),
      },
    },
  };
}
