import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import type { ZodIssue } from "zod/v3";
import {
  createFormRequestSchema,
  createFormResponseSchema,
  draftSaveRequestSchema,
  draftSaveResponseSchema,
  listFormsRequestSchema,
  renameFormRequestSchema,
  renameFormResponseSchema,
  type ListFormsResponse,
} from "@form/contracts";
import { isUuid, type TenantDb } from "@form/database";
import {
  ISSUE_CODES,
  migrateSchema,
  SchemaMigrationError,
  validateDraftSchema,
  type Issue,
  type IssueCode,
} from "@form/form-schema";
import { t, type MessageKey } from "@form/i18n";
import type { AuthSession } from "@form/auth/client";
import {
  CurrentSession,
  EmailVerifiedGuard,
  RequireVerifiedEmail,
} from "../auth/email-verified.guard";
import { sendProblem } from "../common/problem";
import {
  RequireWorkspaceContext,
  TenantDbHandle,
  TenantRequestContextInterceptor,
} from "../workspaces/tenant-context.interceptor";
import { FormsService } from "./forms.service";

/**
 * Forms routes (ticket 06) — the first FULL workspace-context domain routes
 * (spec "Tenancy and authorization": the interceptor opens the transaction,
 * resolves the active workspace through the security-definer
 * `list_workspaces()` and sets `app.workspace_id` transaction-locally):
 *
 *   POST   /v1/forms             create (active workspace + default project
 *                                by flag) — 201 with form + draft
 *   GET    /v1/forms             list, cursor pagination (default 20, max
 *                                100), newest first by (created_at, id)
 *   GET    /v1/forms/{id}        read form + draft (draftVersion + envelope)
 *   PATCH  /v1/forms/{id}        rename the DASHBOARD label only
 *   PUT    /v1/forms/{id}/draft  replace the FULL draft schema atomically
 *                                (ticket 07; optimistic `draftVersion`)
 *
 * Every route requires a verified email (`EmailVerifiedGuard` — 401
 * `unauthenticated` / 403 `email_unverified`) and the FULL tenant context
 * (`TenantRequestContextInterceptor` — 403 `forbidden` with the stable
 * workspace-setup detail when nothing is bootstrapped yet). Unknown or
 * cross-workspace forms answer 404 (never 403 — no enumeration): the query
 * simply returns no row because RLS hides the other workspace's data.
 * Body/query validation failures are 422 `validation_failed` with field
 * errors; all problems are RFC 9457 bodies with i18n titles.
 */
@Controller("forms")
@UseGuards(EmailVerifiedGuard)
@UseInterceptors(TenantRequestContextInterceptor)
export class FormsController {
  // Explicit @Inject keeps constructor DI working in both the vitest/esbuild
  // pipeline and the tsc production build (same pattern as EmailVerifiedGuard).
  constructor(
    @Inject(FormsService) private readonly forms: FormsService,
  ) {}

  @Post()
  @HttpCode(201)
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async create(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @CurrentSession() session: AuthSession | undefined,
    @Res() res: Response,
    @Body() body?: unknown,
  ): Promise<void> {
    const parsed = createFormRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      this.validationProblem(res, parsed.error.issues);
      return;
    }
    const detail = await this.forms.create(
      tenantDb!,
      session!.userId,
      parsed.data.name,
    );
    if (detail === "no_default_project") {
      // A workspace without a default project is a bootstrap invariant
      // violation, not a caller error — stable 500.
      sendProblem(res, 500, "internal_error");
      return;
    }
    // Parse through the shared contract so the response cannot drift.
    const payload = createFormResponseSchema.parse(detail);
    res.status(201).json(payload);
  }

  @Get()
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async list(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = listFormsRequestSchema.safeParse({
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    if (!parsed.success) {
      this.validationProblem(res, parsed.error.issues);
      return;
    }
    const page = await this.forms.list(tenantDb!, parsed.data);
    if (page === "invalid_cursor") {
      sendProblem(res, 422, "validation_failed", {
        errors: [
          { path: "cursor", code: "invalid", message: "Malformed cursor" },
        ],
      });
      return;
    }
    const payload: ListFormsResponse = page;
    res.json(payload);
  }

  @Get(":formId")
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async getById(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @Param("formId") formId: string,
    @Res() res: Response,
  ): Promise<void> {
    // A non-UUID path parameter addresses nothing (and must never reach a
    // uuid-typed SQL cast): 404 like any unknown form.
    if (!isUuid(formId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const detail = await this.forms.getById(tenantDb!, formId);
    if (!detail) {
      sendProblem(res, 404, "not_found");
      return;
    }
    res.json(detail);
  }

  @Patch(":formId")
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async rename(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @Param("formId") formId: string,
    @Res() res: Response,
    @Body() body?: unknown,
  ): Promise<void> {
    if (!isUuid(formId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const parsed = renameFormRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      this.validationProblem(res, parsed.error.issues);
      return;
    }
    const summary = await this.forms.rename(
      tenantDb!,
      formId,
      parsed.data.name,
    );
    if (!summary) {
      sendProblem(res, 404, "not_found");
      return;
    }
    res.json(renameFormResponseSchema.parse(summary));
  }

  /**
   * Draft save (ticket 07): `PUT /v1/forms/{id}/draft` replaces the FULL
   * draft schema atomically.
   *
   * Pipeline: contract parse (wrapper + optimistic token) → `migrateSchema`
   * (future schemaVersions land explicitly; unregistered ones answer 422
   * `unsupported_schema_version`) → the shared engine's `validateDraftSchema`
   * (its stable codes travel verbatim as field errors: NUL →
   * `invalid_character`, byte cap → `schema_too_large`, >200 blocks →
   * `too_many_blocks`, unknown kinds/fields, ID format/duplicates, character
   * limits) → the service's single guarded UPDATE (409 `draft_conflict` on a
   * stale `draftVersion` — another tab's save is never overwritten).
   *
   * The request body is parsed by THIS route's own 300 KB JSON parser (see
   * app.ts — configured, not inherited); oversized bodies answer 413 there.
   */
  @Put(":formId/draft")
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async saveDraft(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @CurrentSession() session: AuthSession | undefined,
    @Param("formId") formId: string,
    @Res() res: Response,
    @Body() body?: unknown,
  ): Promise<void> {
    if (!isUuid(formId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const parsed = draftSaveRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      this.validationProblem(res, parsed.error.issues);
      return;
    }

    // Migrate FIRST so future schemaVersions land explicitly through the
    // registry (v1 is identity); the MIGRATED envelope is what gets validated
    // and stored. Arrays/scalars fall through to the engine, which maps them
    // to the accurate root `invalid_type`.
    const raw = parsed.data.schema;
    let envelope: unknown = raw;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      try {
        envelope = migrateSchema(raw);
      } catch (error) {
        if (error instanceof SchemaMigrationError) {
          sendProblem(res, 422, "validation_failed", {
            errors: [
              {
                path: "schema.schemaVersion",
                code: error.code,
                message: t("errors.schemaIssues.unsupported_schema_version"),
              },
            ],
          });
          return;
        }
        throw error;
      }
    }

    const result = validateDraftSchema(envelope);
    if (!result.ok) {
      sendProblem(res, 422, "validation_failed", {
        errors: result.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: schemaIssueMessage(issue.code),
        })),
      });
      return;
    }

    const outcome = await this.forms.saveDraft(
      tenantDb!,
      formId,
      session!.userId,
      result.value,
      parsed.data.draftVersion,
    );
    if (outcome === null) {
      sendProblem(res, 404, "not_found");
      return;
    }
    if (outcome === "conflict") {
      sendProblem(res, 409, "draft_conflict", {
        detail: t("errors.draftConflict.detail"),
      });
      return;
    }
    res.json(draftSaveResponseSchema.parse(outcome));
  }

  /** Shared 422 writer (RFC 9457 + stable code + field errors). */
  private validationProblem(res: Response, issues: ZodIssue[]): void {
    sendProblem(res, 422, "validation_failed", {
      errors: issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        code: issue.code,
        message: issue.message,
      })),
    });
  }
}

/** The stable engine codes are the contract; their messages come from i18n. */
const SCHEMA_ISSUE_MESSAGE_KEYS = new Map<IssueCode, MessageKey>(
  ISSUE_CODES.map((code) => [code, `errors.schemaIssues.${code}` as MessageKey]),
);

/**
 * i18n message for a stable form-schema issue code. Shared with the publish
 * controller (ticket 09) so both wire the same codes → messages mapping.
 */
export function schemaIssueMessage(code: Issue["code"]): string {
  const key = SCHEMA_ISSUE_MESSAGE_KEYS.get(code);
  // Catalog drift is a programming error — t() throws on a missing key.
  return key ? t(key) : t("errors.validation.title");
}
