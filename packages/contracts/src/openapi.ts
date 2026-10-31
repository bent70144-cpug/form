import { zodToJsonSchema } from "zod-to-json-schema";
import { healthResponseSchema } from "./schemas/health";
import { problemDetailsSchema } from "./schemas/errors";
import {
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  sessionResponseSchema,
  workspaceRefSchema,
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
      { name: "auth", description: "Session boundary (read-only)" },
      {
        name: "workspaces",
        description: "Workspace bootstrap and tenant context",
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
      "/v1/auth/session": {
        get: {
          operationId: "getSession",
          tags: ["auth"],
          summary:
            "Minimal read-only session (workspace null until bootstrap; never writes)",
          responses: {
            "200": {
              description: "Signed-in session; `workspace` is null until bootstrap",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(sessionResponseSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "401": {
              description: "Absent, invalid, expired, or revoked session (empty body)",
            },
          },
        },
      },
      "/v1/workspaces/bootstrap": {
        post: {
          operationId: "bootstrapWorkspace",
          tags: ["workspaces"],
          summary:
            "Idempotent personal-workspace bootstrap (verified email required)",
          description:
            "Runs with ONLY `app.user_id` set (narrow request context) and calls the security-definer `create_personal_workspace()`. Repeated calls return the existing workspace and create no duplicates. Requires a verified email and the same-origin Origin header.",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: zodToJsonSchema(bootstrapRequestSchema, {
                  target: "openApi3",
                }),
              },
            },
          },
          responses: {
            "200": {
              description: "The existing or newly created personal workspace",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(bootstrapResponseSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "401": {
              description: "Unauthenticated (problem details, `unauthenticated`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "403": {
              description:
                "Unverified email (`email_unverified`) or origin mismatch (`origin_mismatch`)",
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
    },
    components: {
      schemas: {
        HealthResponse: zodToJsonSchema(healthResponseSchema, {
          target: "openApi3",
        }),
        ProblemDetails: zodToJsonSchema(problemDetailsSchema, {
          target: "openApi3",
        }),
        WorkspaceRef: zodToJsonSchema(workspaceRefSchema, {
          target: "openApi3",
        }),
        BootstrapResponse: zodToJsonSchema(bootstrapResponseSchema, {
          target: "openApi3",
        }),
        SessionResponse: zodToJsonSchema(sessionResponseSchema, {
          target: "openApi3",
        }),
      },
    },
  };
}
