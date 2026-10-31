import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  buildOpenApiDocument,
  fieldErrorSchema,
  healthResponseSchema,
  problemDetailsSchema,
  problemType,
  sessionResponseSchema,
  workspaceSchema,
} from "../src/index";

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
