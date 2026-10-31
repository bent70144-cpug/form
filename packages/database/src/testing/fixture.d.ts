/**
 * Shared test fixture helpers: deterministic test passwords and an idempotent
 * "bootstrap + migrate" step suites can call. Tests always exercise the REAL
 * roles (`migrator`, `app_user`, `worker_user`, NOLOGIN `fn_owner`) — never a
 * weakened superuser path.
 */
export declare const TEST_PASSWORDS: {
    readonly migrator: "test-migrator-pw";
    readonly appUser: "test-app-user-pw";
    readonly worker: "test-worker-pw";
};
export declare function testRoleUrl(role: "migrator" | "app_user" | "worker_user", database?: string): string;
export interface BootstrappedUrls {
    adminUrl: string;
    migratorUrl: string;
    appUserUrl: string;
    workerUrl: string;
}
/**
 * Idempotent: run in every suite's beforeAll. Performs the one-time admin
 * bootstrap and applies migrations (skipping already-applied ones).
 */
export declare function ensureBootstrapped(database?: string): Promise<BootstrappedUrls>;
/** Creates an empty scratch database for a test that must not share state. */
export declare function createScratchDatabase(name: string): Promise<string>;
export declare function dropDatabase(name: string): Promise<void>;
//# sourceMappingURL=fixture.d.ts.map