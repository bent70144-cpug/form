import { Global, Module } from "@nestjs/common";
import { RateLimiter } from "./rate-limiter";

/**
 * Self-contained Nest module exposing the process-local `RateLimiter`.
 *
 * Deliberately NOT registered anywhere yet: `apps/api/src/app.module.ts` is
 * owned by ticket 03's worktree, so ticket 04's endpoint wiring adds
 * `RateLimitModule` to `AppModule.imports` (or provides `RateLimiter` in a
 * dedicated limiter module) when it lands. See docs/adr/0004-rate-limiting.md.
 *
 * The trusted-IP helpers in `common/trusted-ip` are pure functions and need
 * no provider — wiring calls them directly with `loadTrustedIpConfig()`.
 */
@Global()
@Module({
  providers: [RateLimiter],
  exports: [RateLimiter],
})
export class RateLimitModule {}
