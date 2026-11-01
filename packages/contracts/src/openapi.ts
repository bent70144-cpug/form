import { zodToJsonSchema } from "zod-to-json-schema";
import { healthResponseSchema } from "./schemas/health";
import { problemDetailsSchema } from "./schemas/errors";
import {
  bootstrapResponseSchema,
  sessionResponseSchema,
  workspaceSchema,
} from "./schemas/workspace";
import {
  createFormRequestSchema,
  createFormResponseSchema,
  formDetailSchema,
  formSummarySchema,
  listFormsResponseSchema,
  renameFormRequestSchema,
  renameFormResponseSchema,
} from "./schemas/form";

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
      {
        name: "forms",
        description:
          "Form create/list/read/rename in the active workspace (draft save arrives with ticket 07)",
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
      "/v1/forms": {
        post: {
          operationId: "createForm",
          tags: ["forms"],
          summary:
            "Create a form in the active workspace under the default project",
          description:
            "Runs in the FULL workspace context (active workspace resolved server-side via `list_workspaces()`). The default project is found through `projects.is_default`, never by name. Also creates the form's mutable draft row (empty envelope, `draftVersion` 0) and writes the `form.created` audit row and outbox event in the same transaction. Verified email required.",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: zodToJsonSchema(createFormRequestSchema, {
                  target: "openApi3",
                }),
              },
            },
          },
          responses: {
            "201": {
              description: "The created form with its draft (version 0)",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(createFormResponseSchema, {
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
              description:
                "Email not verified (`email_unverified`), Origin mismatch (`origin_mismatch`), or no workspace yet (`forbidden`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "422": {
              description: "Request body fails the contract (`validation_failed`)",
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
        get: {
          operationId: "listForms",
          tags: ["forms"],
          summary: "List the active workspace's forms, newest first",
          description:
            "Cursor pagination: `limit` defaults to 20 and is capped at 100; `nextCursor` is null on the last page. Ordered newest first by `(created_at, id)`.",
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "One page of form summaries",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(listFormsResponseSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "401": {
              description: "Absent, invalid, expired, or revoked session",
            },
            "403": {
              description:
                "Email not verified or no workspace yet (`forbidden`)",
            },
            "422": {
              description: "Invalid pagination parameters (`validation_failed`)",
            },
          },
        },
      },
      "/v1/forms/{formId}": {
        get: {
          operationId: "getForm",
          tags: ["forms"],
          summary: "Read one form with its mutable draft",
          description:
            "Returns the form and its draft (envelope + integer `draftVersion`). Cross-workspace or unknown ids answer 404 (never 403) to avoid enumeration.",
          parameters: [
            {
              name: "formId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "The form with its draft",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(formDetailSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "401": {
              description: "Absent, invalid, expired, or revoked session",
            },
            "403": {
              description:
                "Email not verified or no workspace yet (`forbidden`)",
            },
            "404": {
              description:
                "Unknown id or a form of another workspace (`not_found`)",
            },
          },
        },
        patch: {
          operationId: "renameForm",
          tags: ["forms"],
          summary: "Rename the form's dashboard label",
          description:
            "Changes `forms.name` ONLY. The respondent-facing title lives in the draft schema envelope and is edited by the builder (ticket 08).",
          parameters: [
            {
              name: "formId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToJsonSchema(renameFormRequestSchema, {
                  target: "openApi3",
                }),
              },
            },
          },
          responses: {
            "200": {
              description: "The renamed form summary",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(renameFormResponseSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "401": {
              description: "Absent, invalid, expired, or revoked session",
            },
            "403": {
              description:
                "Email not verified or no workspace yet (`forbidden`)",
            },
            "404": {
              description:
                "Unknown id or a form of another workspace (`not_found`)",
            },
            "422": {
              description: "Invalid name (`validation_failed`)",
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
        FormSummary: zodToJsonSchema(formSummarySchema, {
          target: "openApi3",
        }),
        FormDetail: zodToJsonSchema(formDetailSchema, {
          target: "openApi3",
        }),
        CreateFormResponse: zodToJsonSchema(createFormResponseSchema, {
          target: "openApi3",
        }),
        ListFormsResponse: zodToJsonSchema(listFormsResponseSchema, {
          target: "openApi3",
        }),
        RenameFormResponse: zodToJsonSchema(renameFormResponseSchema, {
          target: "openApi3",
        }),
      },
    },
  };
}
