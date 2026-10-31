/**
 * Embedded Postgres fixture (spec-sanctioned Docker substitute — see
 * docs/adr/0001-local-infra-substitutes.md).
 *
 * Boots REAL PostgreSQL 17 binaries on 127.0.0.1:5433 (user `postgres`,
 * password `postgres`). Tests use the real non-superuser roles created by the
 * bootstrap; the initdb superuser only plays the admin for that one-time
 * bootstrap. The fixture reuses a server that is already listening (dev
 * supervisor or `pnpm db:start`) so a single instance serves dev + tests.
 */
export declare const EMBEDDED_PG: {
    readonly host: "127.0.0.1";
    readonly port: 5433;
    readonly user: "postgres";
    readonly password: "postgres";
    readonly adminDatabase: "postgres";
    readonly devDatabase: "form_dev";
    readonly testDatabase: "form_test";
};
export declare function adminUrl(database?: string): string;
export declare function isPostgresReachable(port?: number): Promise<boolean>;
export interface EmbeddedPgHandle {
    started: boolean;
    port: number;
}
/**
 * Boot the embedded cluster unless something already answers on the port.
 * Returns whether THIS process started it (only the starter tears it down).
 */
export declare function ensureEmbeddedPostgres(): Promise<EmbeddedPgHandle>;
export declare function stopEmbeddedPostgres(): Promise<void>;
/** PID of the process that booted the cluster, if recorded. */
export declare function embeddedPgOwnerPid(): number | null;
//# sourceMappingURL=embedded.d.ts.map