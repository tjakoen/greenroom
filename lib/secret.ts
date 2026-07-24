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

let warnedDevKey = false;
let cachedKey: Promise<CryptoKey> | null = null;

async function deriveKeyBytes(secret: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new TextEncoder().encode(secret);
  if (raw.length === 32) return raw; // already exactly 256 bits — use as raw key material
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return new Uint8Array(digest);
}

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  cachedKey = (async () => {
    const configured = process.env.SECRET_KEY;
    let keyBytes: Uint8Array<ArrayBuffer>;
    if (configured && configured.trim()) {
      keyBytes = await deriveKeyBytes(configured.trim());
    } else {
      if (!warnedDevKey) {
        warnedDevKey = true;
        console.warn(
          "[lib/secret.ts] SECRET_KEY is not set — using a DEV-ONLY fallback encryption key. " +
            "This MUST be set to a real managed secret before production (losing/rotating it " +
            "just means affected credentials need re-entering — see plans/platform.md §10).",
        );
      }
      keyBytes = await deriveKeyBytes(DEV_ONLY_PASSPHRASE);
    }
    return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  return cachedKey;
}

/** Encrypts `plaintext`, returning a single base64 string packing `iv || ciphertext+tag`. */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString("base64");
}

/** Reverses encryptSecret(): decrypts a base64 `iv || ciphertext+tag` blob back to plaintext. */
export async function decryptSecret(blob: string): Promise<string> {
  const key = await getKey();
  // Copy the Buffer into a plain ArrayBuffer-backed Uint8Array — crypto.subtle wants a real
  // BufferSource, and Buffer's backing store is typed as the wider ArrayBufferLike.
  const combined = new Uint8Array(Buffer.from(blob, "base64"));
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
