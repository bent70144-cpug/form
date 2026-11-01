import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  buildOpenApiDocument,
  createFormRequestSchema,
  createFormResponseSchema,
  fieldErrorSchema,
  formDetailSchema,
  formDraftSchemaSchema,
  healthResponseSchema,
  listFormsResponseSchema,
  problemDetailsSchema,
  problemType,
  renameFormRequestSchema,
  sessionResponseSchema,
  workspaceSchema,
} from "../src/index";

/** The exact M0 empty envelope (form-schema's emptyDraft()). */
const EMPTY_DRAFT = {
  schemaVersion: 1,
  title: "",
  blocks: [],
  logic: [],
  theme: { preset: "default" },
  settings: {},
};

describe("contracts", () => {
  it("validates the health response shape", () => {
    expect(healthResponseSchema.safeParse({ status: "ok", db: true }).success).toBe(
      true,
    );
    expect(
      healthResponseSchema.safeParse({ status: "degraded", db: true }).success,
    ).toBe(false);
  });

  it("validates RFC 9457 problem details", () => {
    const problem = {
      type: problemType("validation"),
      title: "Validation failed",
      status: 422,
      code: ErrorCodes.validation_failed,
      errors: [{ path: "answers.block_id", code: "required", message: "Required" }],
    };
    expect(problemDetailsSchema.safeParse(problem).success).toBe(true);
    expect(fieldErrorSchema.safeParse(problem.errors?.[0]).success).toBe(true);
  });

  it("declares the full stable M0 error code set", () => {
    expect(Object.keys(ErrorCodes).sort()).toEqual(
      [
        "validation_failed",
        "malformed_request",
        "unauthenticated",
        "forbidden",
        "email_unverified",
        "origin_mismatch",
        "not_found",
        "draft_conflict",
        "form_full",
        "invalid_character",
        "schema_too_large",
        "submission_too_large",
        "rate_limited",
        "internal_error",
      ].sort(),
    );
  });
  it("validates the workspace bootstrap and session contracts (ticket 05)", () => {
    const workspace = {
      id: "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b",
      name: "Personal Workspace",
      role: "owner",
    };
    expect(workspaceSchema.safeParse(workspace).success).toBe(true);
    expect(
      workspaceSchema.safeParse({ ...workspace, role: "root" }).success,
    ).toBe(false);

    // Bootstrap: empty request (caller derived from the session), workspace response.
    expect(bootstrapRequestSchema.safeParse({}).success).toBe(true);
    expect(bootstrapRequestSchema.safeParse({ workspaceId: "x" }).success).toBe(
      false,
    );
    expect(
      bootstrapResponseSchema.safeParse({ workspace }).success,
    ).toBe(true);

    // Session: workspace null before bootstrap, ref after.
    expect(
      sessionResponseSchema.safeParse({
        userId: "u1",
        email: "u@example.com",
        emailVerified: true,
        workspace: null,
      }).success,
    ).toBe(true);
    expect(
      sessionResponseSchema.safeParse({
        userId: "u1",
        email: "u@example.com",
        emailVerified: true,
        workspace,
      }).success,
    ).toBe(true);
  });

  it("validates the form create/list/rename contracts (ticket 06)", () => {
    const formId = "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b";
    const projectId = "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7c";
    const now = new Date().toISOString();

    // Create: body is optional (an empty object is valid — server-side
    // default name); a name must be 1..200 chars.
    expect(createFormRequestSchema.safeParse({}).success).toBe(true);
    expect(createFormRequestSchema.safeParse({ name: "Client intake" }).success).toBe(true);
    expect(createFormRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createFormRequestSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
    expect(createFormRequestSchema.safeParse({ projectId }).success).toBe(false);

    // The empty draft envelope validates as the wire DTO.
    expect(formDraftSchemaSchema.safeParse(EMPTY_DRAFT).success).toBe(true);
    expect(formDraftSchemaSchema.safeParse({ ...EMPTY_DRAFT, extra: 1 }).success).toBe(false);

    // Create response: form + draft (draftVersion 0, empty envelope).
    const detail = {
      id: formId,
      name: "Untitled form",
      status: "draft",
      projectId,
      createdAt: now,
      updatedAt: now,
      draft: { draftVersion: 0, schema: EMPTY_DRAFT },
    };
    expect(formDetailSchema.safeParse(detail).success).toBe(true);
    expect(createFormResponseSchema.safeParse(detail).success).toBe(true);
    expect(
      formDetailSchema.safeParse({ ...detail, draft: { draftVersion: -1, schema: EMPTY_DRAFT } })
        .success,
    ).toBe(false);
    expect(
      formDetailSchema.safeParse({ ...detail, status: "archived" }).success,
    ).toBe(false);

    // List: page of summaries + nullable cursor.
    expect(
      listFormsResponseSchema.safeParse({
        forms: [
          {
            id: formId,
            name: "Untitled form",
            status: "draft",
            createdAt: now,
            updatedAt: now,
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      listFormsResponseSchema.safeParse({ forms: [], nextCursor: "abc" }).success,
    ).toBe(true);

    // Rename: name required, 1..200.
    expect(renameFormRequestSchema.safeParse({ name: "Client intake" }).success).toBe(true);
    expect(renameFormRequestSchema.safeParse({}).success).toBe(false);
    expect(renameFormRequestSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("exposes the form endpoints in the document (ticket 06)", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { operationId?: string }>>;
      tags: Array<{ name: string }>;
    };
    expect(doc.paths["/v1/forms"]?.post?.operationId).toBe("createForm");
    expect(doc.paths["/v1/forms"]?.get?.operationId).toBe("listForms");
    expect(doc.paths["/v1/forms/{formId}"]?.get?.operationId).toBe("getForm");
    expect(doc.paths["/v1/forms/{formId}/name"]?.patch?.operationId).toBe(
      "renameForm",
    );
    expect(doc.tags.map((tag) => tag.name)).toContain("forms");
  });
});

describe("openapi document", () => {
  it("matches the committed snapshot", () => {
    expect(buildOpenApiDocument()).toMatchSnapshot();
  });

  it("exposes /v1/health with a generated response schema", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, unknown>>;
      openapi: string;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/health"]).toBeTruthy();
    const get = doc.paths["/v1/health"] as {
      get: { responses: Record<string, { content: Record<string, unknown> }> };
    };
    expect(
      get.get.responses["200"]?.content["application/json"],
    ).toBeTruthy();
  });

  it("exposes /v1/auth/session and /v1/workspaces/bootstrap (ticket 05)", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(doc.paths["/v1/auth/session"]?.get?.operationId).toBe("getSession");
    expect(
      doc.paths["/v1/workspaces/bootstrap"]?.post?.operationId,
    ).toBe("bootstrapWorkspace");
  });
});
