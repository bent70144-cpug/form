import { z } from "zod";

/**
 * Liveness + database reachability (spec: "A health endpoint reports process
 * liveness and database reachability without exposing tenant data").
 */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  db: z.boolean(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
