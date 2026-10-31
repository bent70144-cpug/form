export interface RunMigrationsOptions {
    /** Direct (non-pooled) connection string for the `migrator` role. */
    databaseUrl: string;
    /** Directory containing `NNNN_*.sql` files. */
    dir?: string;
    /** Fail when an already-applied file no longer matches its checksum. */
    verifyChecksums?: boolean;
}
export interface RunMigrationsResult {
    applied: string[];
    skipped: number;
}
export declare function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult>;
//# sourceMappingURL=runner.d.ts.map