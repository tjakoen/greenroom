// lib/secret.ts — AES-256-GCM at-rest encryption for test-target passwords
// (`credential.secretEnc`, db/schema.ts; plans/platform.md §3 + the "Secret encryption key
// management" risk in §10). Uses WebCrypto (`crypto.subtle`) — globally available under Bun,
// so this earns no new dependency.
//
// Format: encryptSecret() returns a single base64 string packing `iv (12 bytes) || ciphertext
// (GCM appends its 16-byte auth tag to the ciphertext itself, per the WebCrypto AES-GCM spec)`.
// decryptSecret() reverses it: slice the first 12 bytes back off as the IV, decrypt the rest.
//
// Key management (§10 risk, read before touching this file):
//   - Set `SECRET_KEY` in production. It is turned into a 256-bit AES key by either (a) using it
//     directly as raw key bytes if it's exactly 32 bytes long, or (b) SHA-256-hashing it
//     otherwise — so an ordinary passphrase of any length still yields a valid AES-256 key.
//   - If `SECRET_KEY` is UNSET, this module falls back to a DEV-ONLY key derived from a fixed,
//     publicly-visible string (see DEV_ONLY_PASSPHRASE below) and prints a ONE-TIME console.warn.
//     That fallback is fine for local dev (it's what P0/P1 run under before deploy hardening)
//     but MUST NOT be used in production — anyone who reads this file can derive it.
//   - Losing or rotating `SECRET_KEY` makes every existing `secretEnc` value undecryptable. Per
//     §10 this is **re-enterable, not catastrophic**: the affected test-target credentials just
//     need to be typed back into the Accounts UI once a superadmin notices logins are failing.
//     There is no backward-compatible "old key" migration path here on purpose — rotate by
//     re-entering, not by trying to re-encrypt.
const DEV_ONLY_PASSPHRASE =
  "greenroom-dev-only-INSECURE-fallback-key-DO-NOT-USE-IN-PRODUCTION-set-SECRET_KEY-instead";

// Key-derivation hardening (audit: a single unsalted SHA-256 lets an attacker who steals the DB
// mount a fast offline brute-force of a passphrase SECRET_KEY). New ciphertexts are tagged with
// this prefix and derive the AES key via PBKDF2-SHA256 (200k iterations) instead — orders of
// magnitude more work per guess. A fixed app salt (no per-install persistence to manage) still
// defeats generic rainbow tables and adds the stretching cost; a per-install random salt stored
// alongside the DB would harden it further and is the natural next step. LEGACY blobs (no prefix)
// keep decrypting via the old single-SHA-256 derivation, so no credential re-entry is forced.
const V2_PREFIX = "g2:";
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_SALT = new TextEncoder().encode("greenroom/secret.ts/pbkdf2/v2");

let warnedDevKey = false;
let legacyKey: Promise<CryptoKey> | null = null;
let v2Key: Promise<CryptoKey> | null = null;

/** The configured passphrase (trimmed), or the dev fallback with a one-time warning. */
function secretString(): string {
  const configured = process.env.SECRET_KEY;
  if (configured && configured.trim()) return configured.trim();
  if (!warnedDevKey) {
    warnedDevKey = true;
    console.warn(
      "[lib/secret.ts] SECRET_KEY is not set — using a DEV-ONLY fallback encryption key. " +
        "This MUST be set to a real managed secret before production (losing/rotating it " +
        "just means affected credentials need re-entering — see plans/platform.md §10).",
    );
  }
  return DEV_ONLY_PASSPHRASE;
}

/** Legacy derivation: raw bytes if the secret is exactly 32 bytes, else one SHA-256 pass. */
async function deriveLegacyBytes(secret: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new TextEncoder().encode(secret);
  if (raw.length === 32) return raw;
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return new Uint8Array(digest);
}

/** V2 derivation: raw bytes if exactly 32 (already strong), else PBKDF2-SHA256 stretching. */
async function deriveV2Bytes(secret: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new TextEncoder().encode(secret);
  if (raw.length === 32) return raw;
  const base = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: PBKDF2_SALT, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    256,
  );
  return new Uint8Array(bits);
}

function importAes(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
function getLegacyKey(): Promise<CryptoKey> {
  return (legacyKey ??= deriveLegacyBytes(secretString()).then(importAes));
}
function getV2Key(): Promise<CryptoKey> {
  return (v2Key ??= deriveV2Bytes(secretString()).then(importAes));
}

/** Encrypts `plaintext`, returning `"g2:" + base64(iv || ciphertext+tag)` (PBKDF2-derived key). */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getV2Key();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return V2_PREFIX + Buffer.from(combined).toString("base64");
}

/** Reverses encryptSecret(): a `g2:`-tagged blob uses the PBKDF2 key, an untagged (legacy) blob
 *  the old single-SHA-256 key — so credentials written before this change still decrypt. */
export async function decryptSecret(blob: string): Promise<string> {
  const tagged = blob.startsWith(V2_PREFIX);
  const key = tagged ? await getV2Key() : await getLegacyKey();
  const b64 = tagged ? blob.slice(V2_PREFIX.length) : blob;
  // Copy the Buffer into a plain ArrayBuffer-backed Uint8Array — crypto.subtle wants a real
  // BufferSource, and Buffer's backing store is typed as the wider ArrayBufferLike.
  const combined = new Uint8Array(Buffer.from(b64, "base64"));
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
