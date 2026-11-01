/**
 * Local 12-character URL-safe block-ID generator (ticket 08, nanoid-style,
 * no new dependency).
 *
 * The builder generates block IDs client-side ON ADD only; edit, reorder and
 * delete never regenerate them (stability is pinned by tests and enforced by
 * the server's optimistic draft updates). The shared contract is
 * `BLOCK_ID_RE` (10–32 chars of [A-Za-z0-9_-]) from @form/form-schema — this
 * generator emits a strict subset: exactly 12 chars from a 64-symbol
 * URL-safe alphabet. 256 % 64 === 0, so `crypto.getRandomValues` bytes map
 * onto the alphabet without modulo bias.
 */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ID_LENGTH = 12;

function randomBytes(bytes: Uint8Array): void {
  globalThis.crypto.getRandomValues(bytes);
}

/**
 * A fresh 12-char block ID. `exclude` (optional) makes the draw skip IDs
 * already present in the form (belt and braces — duplicate IDs are practically
 * impossible at 64^12 and the server rejects them anyway).
 */
export function generateBlockId(exclude?: ReadonlySet<string>): string {
  for (;;) {
    const bytes = new Uint8Array(ID_LENGTH);
    randomBytes(bytes);
    let id = "";
    for (let i = 0; i < ID_LENGTH; i++) {
      id += ALPHABET[bytes[i]! % ALPHABET.length];
    }
    if (!exclude?.has(id)) return id;
  }
}
