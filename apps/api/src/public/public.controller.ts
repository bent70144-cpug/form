import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import type { Pool } from "pg";
import { publicFormPublishedSchema } from "@form/contracts";
import { sendProblem } from "../common/problem";
import { APP_DB_POOL } from "../db/app-db";

/**
 * Public read-only render path (ticket 09) — `GET /v1/public/forms/{slug}` is
 * UNauthenticated and cookie-less (spec: "Next.js SSR calls an unauthenticated
 * GET /v1/public/forms/{slug} over the internal API URL because the web app
 * has no database access"). The controller carries NO auth guard, NO workspace
 * context and NO tenant transaction: it is deliberately outside the
 * EmailVerifiedGuard / TenantRequestContextInterceptor pair.
 *
 * It wraps the security-definer `get_published_form(slug)` executed AS
 * `app_user` on the pooled tenant connection (the function is designed to
 * cross tenants; the raw slug registry itself is NOT readable — app_user's
 * form_slugs policy stays tenant-gated and this handler only ever calls the
 * function). Status mapping per spec:
 *
 *   published → 200 { formId, versionId, versionNumber, schema } (immutable
 *               snapshot — drafts are structurally unreachable)
 *   closed    → 200 { status: "closed" } (unpublished OR soft-deleted OR
 *               never-published — a respondent sees the closed message)
 *   redirect  → 308 with `Location: /f/{canonicalSlug}` (superseded slug)
 *   not_found → 404 problem
 *
 * EVERY response (including 308 and 404) carries `Cache-Control: no-store` so
 * unpublish and republish take effect immediately without a purge story. A
 * future password gate sits in front of this same endpoint; session creation
 * (ticket 10) uses the DISTINCT resolve_public_form() path and never this one.
 */
const CANONICAL_SLUG_RE = /^[A-Za-z0-9]{10}$/;

@Controller("public")
export class PublicFormController {
  constructor(@Inject(APP_DB_POOL) private readonly pool: Pool) {}

  @Get("forms/:slug")
  async getPublishedForm(
    @Param("slug") slug: string,
    @Res() res: Response,
  ): Promise<void> {
    // No-cache is the M0 caching story for EVERY status below (spec).
    res.set("Cache-Control", "no-store");

    const result = await this.pool.query<{ result: unknown }>(
      `SELECT app.get_published_form($1) AS result`,
      [slug],
    );
    const raw = result.rows[0]?.result as Record<string, unknown> | null;
    const status = raw?.status;

    if (status === "published") {
      // Parse through the shared contract so the response cannot drift.
      const payload = publicFormPublishedSchema.parse({
        status: "published",
        formId: raw!.formId,
        versionId: raw!.versionId,
        versionNumber: raw!.versionNumber,
        schema: raw!.schema,
      });
      res.json(payload);
      return;
    }

    if (status === "closed") {
      res.json({ status: "closed" });
      return;
    }

    if (status === "redirect") {
      const canonical = raw!.canonicalSlug;
      // The registry is the only source of canonical slugs; a malformed value
      // would be contract drift — answer 404 instead of redirecting anywhere.
      if (typeof canonical !== "string" || !CANONICAL_SLUG_RE.test(canonical)) {
        sendProblem(res, 404, "not_found");
        return;
      }
      res.redirect(308, `/f/${canonical}`);
      return;
    }

    sendProblem(res, 404, "not_found");
  }
}
