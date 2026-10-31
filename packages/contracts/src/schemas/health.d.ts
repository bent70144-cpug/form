import { z } from "zod/v3";
/**
 * Liveness + database reachability (spec: "A health endpoint reports process
 * liveness and database reachability without exposing tenant data").
 */
export declare const healthResponseSchema: z.ZodObject<{
    status: z.ZodLiteral<"ok">;
    db: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    status: "ok";
    db: boolean;
}, {
    status: "ok";
    db: boolean;
}>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
//# sourceMappingURL=health.d.ts.map