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
  draftSaveRequestSchema,
  draftSaveResponseSchema,
  formDetailSchema,
  formSummarySchema,
  listFormsResponseSchema,
  renameFormRequestSchema,
  renameFormResponseSchema,
} from "./schemas/form";
import {
  publishResponseSchema,
  publicFormResponseSchema,
  unpublishResponseSchema,
} from "./schemas/publish";
import {
  sessionCreateResponseSchema,
  submitReceiptSchema,
  submitRequestSchema,
} from "./schemas/public-session";
import {
  listSubmissionsResponseSchema,
  submissionDetailSchema,
} from "./schemas/submission";

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
          "Form create/list/read/rename and draft save in the active workspace",
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
      "/v1/forms/{formId}/publish": {
        post: {
          operationId: "publishForm",
          tags: ["forms"],
          summary: "Publish (or republish) the form as a new immutable version",
          description:
            "ONE transaction: locks the form row (SELECT … FOR UPDATE), re-runs the FULL publish validation, allocates the next version number, inserts the immutable form_versions snapshot, updates the published pointer and status to `published`, registers the public slug on first publish (`register_form_slug`, 10-char base62; reserved words rejected), and writes the `form.published` audit row and outbox event. Validation failures answer 422 with the engine's stable codes and persist NOTHING; an injected failure rolls back everything; concurrent publishes serialize on the form row. The first publish allocates the public slug; republishes keep it. Response carries worstCaseBytes/submissionCapBytes so the dashboard can render the publish-time size warning.",
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
              description: "Published — the immutable version + public slug + size-warning numbers",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(publishResponseSchema, {
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
                "Email not verified, Origin mismatch, or no workspace yet (`forbidden`)",
            },
            "404": {
              description:
                "Unknown id or a form of another workspace (`not_found`)",
            },
            "422": {
              description:
                "Draft fails publish validation (`no_question_blocks`, `empty_label`, `welcome_not_first`, `ending_not_last`, `duplicate_block_id`, `multiple_welcome_blocks`, `multiple_ending_blocks`, limits, ...) — nothing is persisted",
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
      "/v1/forms/{formId}/unpublish": {
        post: {
          operationId: "unpublishForm",
          tags: ["forms"],
          summary: "Unpublish the form — it reads as closed to respondents",
          description:
            "Sets the form status to `closed` and writes the `form.unpublished` audit row and outbox event in the same transaction. Republishing reopens the form with a new immutable version. Cross-workspace or unknown ids answer 404.",
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
              description: "The form is closed",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(unpublishResponseSchema, {
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
                "Email not verified, Origin mismatch, or no workspace yet (`forbidden`)",
            },
            "404": {
              description:
                "Unknown id or a form of another workspace (`not_found`)",
            },
          },
        },
      },
      "/v1/public/forms/{slug}": {
        get: {
          operationId: "getPublicForm",
          tags: ["forms"],
          summary:
            "Read the published form by public slug (UNauthenticated, cookie-less)",
          description:
            "Wraps the security-definer `get_published_form(slug)` as app_user (cross-tenant by design; the slug registry is not directly readable). `published` → 200 with the immutable snapshot; `closed` (unpublished or soft-deleted) → 200 closed; `redirect` (superseded slug) → 308 Location /f/{canonicalSlug}; `not_found` → 404. Every response sends `Cache-Control: no-store`. Drafts are structurally unreachable. A future password gate sits in front of this endpoint.",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^[A-Za-z0-9]{10}$" },
            },
          ],
          responses: {
            "200": {
              description: "Published snapshot or the closed state",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(publicFormResponseSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "308": {
              description: "Superseded slug — permanent redirect to /f/{canonicalSlug}",
            },
            "404": {
              description: "Unknown slug (`not_found`)",
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
      "/v1/public/forms/{slug}/sessions": {
        post: {
          operationId: "createPublicSession",
          tags: ["forms"],
          summary:
            "Create a pinned public session (UNauthenticated, cookie-less)",
          description:
            "Wraps the security-definer resolve_public_form(slug) — only published, non-deleted forms resolve (404 otherwise). Returns the RAW session token ONCE (only its SHA-256 hash is stored), the 24h expiry, the pinned published version id, and the pinned schema. Rate-limited to 30 requests per hour per trusted client IP AND per form (429 rate_limited). app.workspace_id is set from the resolved form, never from the client; a forged workspace header is ignored.",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^[A-Za-z0-9]{10}$" },
            },
          ],
          responses: {
            "200": {
              description: "The pinned session (token returned once)",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(sessionCreateResponseSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "404": {
              description:
                "Unknown slug, or the form is not currently published (`not_found`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "429": {
              description:
                "Session-creation limit exhausted (`rate_limited`, Retry-After)",
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
      "/v1/public/submissions": {
        post: {
          operationId: "submitPublicForm",
          tags: ["forms"],
          summary:
            "Submit answers for a public session (UNauthenticated, cookie-less)",
          description:
            "ONE transaction per spec: resolve the session by the SHA-256 of the raw X-Form-Session token (resolve_form_session), reject unknown (404), expired-beyond-grace (410) or completed sessions, verify the form is still published and the pinned version exists (409 form_closed), validate the answers against the PINNED schema (422 with stable per-answer codes), lock the form row and enforce the per-form submission cap (409 form_full), insert the submission (UNIQUE form_session_id makes retries idempotent — the loser of a concurrent race gets the SAME receipt), mark the session completed, and write the submission.created audit row + outbox event. Stored answers are never returned. app.workspace_id always comes from the resolved session, never from the client.",
          parameters: [
            {
              name: "X-Form-Session",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "The raw session token from session creation.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: zodToJsonSchema(submitRequestSchema, {
                  target: "openApi3",
                }),
              },
            },
          },
          responses: {
            "200": {
              description:
                "The idempotent receipt (first submit or a retry/race loser)",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(submitReceiptSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "401": {
              description: "Missing X-Form-Session header (`session_required`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "404": {
              description: "Unknown session token (`session_not_found`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "409": {
              description:
                "Form closed or deleted (`form_closed`), per-form submission cap reached (`form_full`), or a completed session without a stored submission (`session_completed`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "410": {
              description:
                "Session expired beyond the 5-minute grace window (`session_expired`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "413": {
              description:
                "Body exceeds the route's configured 150 KB JSON limit",
            },
            "422": {
              description:
                "Answer validation against the pinned schema failed (`validation_failed` with per-answer codes: `unknown_block_id`, `answer_to_non_question`, `required_answer_missing`, `answer_too_long`, `invalid_character`, `submission_too_large`, `invalid_answer_type`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "429": {
              description: "Session-creation limit exhausted on the paired session route (`rate_limited`)",
            },
          },
        },
      },
      "/v1/forms/{formId}/draft": {
        put: {
          operationId: "saveFormDraft",
          tags: ["forms"],
          summary: "Replace the form's FULL draft schema atomically",
          description:
            "Optimistic concurrency on `draftVersion`: the caller sends the last-seen integer; a mismatch answers 409 `draft_conflict` instead of overwriting another tab's save, and success increments `draftVersion` by 1. The envelope is migrated through the schemaVersion registry and validated by the shared schema engine — structural, limit, ID and NUL failures answer 422 with the engine's stable codes as field errors. The body parser limit for this route is explicitly configured at 300 KB (larger bodies answer 413 before validation).",
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
                schema: zodToJsonSchema(draftSaveRequestSchema, {
                  target: "openApi3",
                }),
              },
            },
          },
          responses: {
            "200": {
              description: "Draft saved; returns the NEW draft version",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(draftSaveResponseSchema, {
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
            "409": {
              description:
                "Stale `draftVersion` — another save landed first (`draft_conflict`)",
              content: {
                "application/problem+json": {
                  schema: zodToJsonSchema(problemDetailsSchema, {
                    target: "openApi3",
                  }),
                },
              },
            },
            "413": {
              description:
                "Body exceeds the route's configured 300 KB JSON limit",
            },
            "422": {
              description:
                "Invalid wrapper (`validation_failed`) or schema-engine rejections (stable field codes: `unsupported_schema_version`, `invalid_character`, `schema_too_large`, `too_many_blocks`, `duplicate_block_id`, `invalid_block_id`, `unsupported_block_kind`, `unknown_field`, `*_too_long`, ...)",
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
      "/v1/forms/{formId}/submissions": {
        get: {
          operationId: "listSubmissions",
          tags: ["forms"],
          summary: "List a form's submissions, newest first",
          description:
            "Authenticated workspace route (FULL tenant context; RLS is the boundary — an unknown or cross-workspace form is 404, never 403). Cursor pagination: `limit` defaults to 20 and is capped at 100; `nextCursor` is null on the last page. Ordered newest first by `(created_at, id)` (spec API conventions).",
          parameters: [
            {
              name: "formId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
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
              description: "One page of submission summaries",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(listSubmissionsResponseSchema, {
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
                "Unknown form or a form of another workspace (`not_found`)",
            },
            "422": {
              description: "Invalid pagination parameters (`validation_failed`)",
            },
          },
        },
      },
      "/v1/forms/{formId}/submissions/{submissionId}": {
        get: {
          operationId: "getSubmission",
          tags: ["forms"],
          summary: "Read one submission with its pinned version's schema",
          description:
            "Authenticated workspace route. Returns the stored answers plus the PINNED form version's schema envelope so the inbox pairs each answer with the question label the respondent actually saw — never the current draft. Unknown or cross-workspace submissions answer 404.",
          parameters: [
            {
              name: "formId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "submissionId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "The submission detail with its pinned schema",
              content: {
                "application/json": {
                  schema: zodToJsonSchema(submissionDetailSchema, {
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
                "Unknown submission or a submission of another workspace (`not_found`)",
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
        DraftSaveResponse: zodToJsonSchema(draftSaveResponseSchema, {
          target: "openApi3",
        }),
        PublishResponse: zodToJsonSchema(publishResponseSchema, {
          target: "openApi3",
        }),
        UnpublishResponse: zodToJsonSchema(unpublishResponseSchema, {
          target: "openApi3",
        }),
        PublicFormResponse: zodToJsonSchema(publicFormResponseSchema, {
          target: "openApi3",
        }),
        SessionCreateResponse: zodToJsonSchema(sessionCreateResponseSchema, {
          target: "openApi3",
        }),
        SubmitRequest: zodToJsonSchema(submitRequestSchema, {
          target: "openApi3",
        }),
        SubmitReceipt: zodToJsonSchema(submitReceiptSchema, {
          target: "openApi3",
        }),
        ListSubmissionsResponse: zodToJsonSchema(listSubmissionsResponseSchema, {
          target: "openApi3",
        }),
        SubmissionDetail: zodToJsonSchema(submissionDetailSchema, {
          target: "openApi3",
        }),
      },
    },
  };
}
