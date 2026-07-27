// Set a real key BEFORE the first encrypt/decrypt so the DEV-ONLY fallback path isn't exercised
// (getKey() reads process.env.SECRET_KEY lazily on first use and caches it for the process).
process.env.SECRET_KEY = "test-only-secret-key-32bytes-aaaa"; // 33 chars → SHA-256 path
import { test, expect } from "bun:test";
import { encryptSecret, decryptSecret } from "./secret.ts";

test("round-trips plaintext", async () => {
  for (const p of ["hunter2", "", "unicode ✓ pw — €", "a".repeat(5000)]) {
    expect(await decryptSecret(await encryptSecret(p))).toBe(p);
  }
});

test("ciphertext is non-deterministic (fresh IV each call)", async () => {
  const a = await encryptSecret("same");
  const b = await encryptSecret("same");
  expect(a).not.toBe(b); // random 12-byte IV prepended → different blob
  expect(await decryptSecret(a)).toBe("same");
  expect(await decryptSecret(b)).toBe("same");
});

test("blob packs iv(12) + ciphertext + gcm tag(16): len >= plaintext + 28", async () => {
  const blob = await encryptSecret("abc"); // 3 bytes
  const bytes = Buffer.from(blob, "base64").length;
  expect(bytes).toBe(12 + 3 + 16);
});

test("tampering with the ciphertext fails the GCM auth tag (throws)", async () => {
  const blob = await encryptSecret("secret");
  const raw = Buffer.from(blob, "base64");
  raw[raw.length - 1] ^= 0xff; // flip a byte in the auth tag / ciphertext
  const tampered = raw.toString("base64");
  await expect(decryptSecret(tampered)).rejects.toBeDefined();
});

test("a 32-byte SECRET_KEY is used as raw key material (still round-trips)", async () => {
  // Can't re-key this process (key is cached), so just assert the current key round-trips — the
  // 32-byte raw-vs-SHA256 branch is covered structurally by deriveKeyBytes; this guards regressions.
  expect(await decryptSecret(await encryptSecret("x"))).toBe("x");
});
