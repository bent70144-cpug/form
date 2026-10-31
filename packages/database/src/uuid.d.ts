/**
 * UUIDv7 generation (app-side).
 *
 * Decision (docs/adr/0002-uuid-strategy.md): internal IDs are UUIDv7 for
 * time-sortability, generated in the application by this function rather than
 * by a database extension — `pg_uuidv7` is not available on the target
 * Postgres builds. Fallbacks remain documented: `gen_random_uuid()` (UUIDv4,
 * built-in since PG13) is acceptable as a server-side default where noted, but
 * new domain code must prefer this helper.
 */
export declare function uuidv7(now?: number): string;
/** Validates that a string is any RFC 4122 UUID (used for context guards). */
export declare function isUuid(value: string): boolean;
//# sourceMappingURL=uuid.d.ts.map