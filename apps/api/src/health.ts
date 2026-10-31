import { healthResponseSchema } from "@form/contracts";
import { t } from "@form/i18n";

/**
 * Health module (spec: "A health endpoint reports process liveness and
 * database reachability without exposing tenant data").
 *
 * The response body is validated against the shared contract so the API and
 * the OpenAPI document cannot drift.
 */
export interface HealthModule {
  /** Runs the liveness + database-reachability check. */
  getHealth(): Promise<{
    status: "ok";
    db: boolean;
    message: string;
  }>;
}

export function createHealthModule(options: {
  /** Returns true when a trivial query succeeds against Postgres. */
  checkDatabase: () => Promise<boolean>;
}): HealthModule {
  return {
    async getHealth() {
      let db = false;
      try {
        db = await options.checkDatabase();
      } catch {
        db = false;
      }
      return {
        status: "ok",
        db,
        message: db ? t("common.health.ok") : t("common.health.unreachable"),
      };
    },
  };
}

/** Validates a health payload against the shared contract. */
export function validateHealthResponse(payload: {
  status: "ok";
  db: boolean;
}): { status: "ok"; db: boolean } {
  return healthResponseSchema.parse(payload);
}
