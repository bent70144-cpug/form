import { zodToJsonSchema } from "zod-to-json-schema";
import { healthResponseSchema } from "./schemas/health";
import { problemDetailsSchema } from "./schemas/errors";
import {
  bootstrapResponseSchema,
  sessionResponseSchema,
  workspaceSchema,
} from "./schemas/workspace";

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
      {
        name: "workspaces",
        description: "Workspace bootstrap and tenant-scoped resources",
      },
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
                    target: "openApi3",
                  }),
                },
              },
            },
            "500": {
              description: "Unexpected failure",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
          },
        },
      },
      "/v1/workspaces/bootstrap": {
        post: {
          operationId: "bootstrapWorkspace",
          tags: ["workspaces"],
          summary: "Idempotent personal-workspace bootstrap",
          description:
            "Requires a verified-email session (401 unauthenticated, 403 email_unverified otherwise) and a same-origin Origin header (mutation). Calls create_personal_workspace(); repeated calls return the existing workspace without duplicates.",
          responses: {
            "200": {
              description: "Existing or newly created personal workspace",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(bootstrapResponseSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "401": {
              description: "Absent, invalid, expired, or revoked session",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "403": {
              description: "Email not verified (`email_unverified`) or Origin mismatch (`origin_mismatch`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "429": {
              description: "Rate limit exceeded (`rate_limited`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
          },
        },
      },
      "/v1/auth/session": {
        get: {
          operationId: "getSession",
          tags: ["auth"],
          summary: "Minimal session object",
          description:
            "Returns the signed-in user's id, email, verified flag and the active workspace when one exists; 401 with no detail otherwise. Read-only.",
          responses: {
            "200": {
              description: "Session (workspace null until bootstrap)",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(sessionResponseSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "401": {
              description: "Absent, invalid, expired, or revoked session",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
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
          target: "openApi3",
        }),
        ProblemDetails: zodToJsonSchema(problemDetailsSchema, {
          target: "openApi3",
        }),
        Workspace: zodToJsonSchema(workspaceSchema, {
          target: "openApi3",
        }),
      },
    },
  };
}
