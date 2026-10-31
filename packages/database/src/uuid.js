"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uuidv7 = uuidv7;
exports.isUuid = isUuid;
const node_crypto_1 = require("node:crypto");
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
function uuidv7(now = Date.now()) {
    const bytes = (0, node_crypto_1.randomBytes)(16);
    const ts = BigInt(now) & 0xffffffffffffn; // 48-bit unix milliseconds
    bytes[0] = Number((ts >> 40n) & 0xffn);
    bytes[1] = Number((ts >> 32n) & 0xffn);
    bytes[2] = Number((ts >> 24n) & 0xffn);
    bytes[3] = Number((ts >> 16n) & 0xffn);
    bytes[4] = Number((ts >> 8n) & 0xffn);
    bytes[5] = Number(ts & 0xffn);
    // version 7 (0b0111) in the high nibble of byte 6
    const b6 = bytes[6] ?? 0;
    bytes[6] = (0x70 | (b6 & 0x0f)) & 0xff;
    // variant 10xx in the two high bits of byte 8
    const b8 = bytes[8] ?? 0;
    bytes[8] = (0x80 | (b8 & 0x3f)) & 0xff;
    const hex = bytes.toString("hex");
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join("-");
}
/** Validates that a string is any RFC 4122 UUID (used for context guards). */
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
//# sourceMappingURL=uuid.js.map