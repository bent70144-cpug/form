// Import the v3 API explicitly: zod 3.25 ships v3+v4 in one package and
// zod-to-json-schema is typed against `zod/v3`. Mixing the root re-export with
// `zod/v3` types triggers a TS2589 instantiation explosion (OOM-scale check).
import { z } from "zod/v3";

/**
 * Liveness + database reachability (spec: "A health endpoint reports process
 * liveness and database reachability without exposing tenant data").
 */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  db: z.boolean(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
