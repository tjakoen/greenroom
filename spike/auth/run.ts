// spike/auth/run.ts
// THROWAWAY spike (P0 spike B) — server-side round trip, no browser required:
// sign up (email+password) -> sign in -> verify the session resolves back to that user.
//
// Run with: bun spike/auth/run.ts
import { auth } from "./auth";

const email = `spike-${Date.now()}@example.com`;
const password = "correct-horse-battery-staple";
const name = "Spike User";

console.log("1) signUpEmail...");
const signUpResult = await auth.api.signUpEmail({
  body: { email, password, name },
  asResponse: true,
});
if (!signUpResult.ok) {
  throw new Error(`signUpEmail failed: ${signUpResult.status} ${await signUpResult.text()}`);
}
const signUpBody = await signUpResult.json();
console.log("   created user id:", signUpBody.user.id, signUpBody.user.email);

console.log("2) signInEmail...");
const signInResult = await auth.api.signInEmail({
  body: { email, password },
  asResponse: true,
});
if (!signInResult.ok) {
  throw new Error(`signInEmail failed: ${signInResult.status} ${await signInResult.text()}`);
}
const signInBody = await signInResult.json();
const setCookie = signInResult.headers.get("set-cookie");
if (!setCookie) throw new Error("signInEmail did not return a session cookie");
console.log("   signed in user id:", signInBody.user.id);

// better-auth's set-cookie can contain multiple cookies comma-joined in a single header when
// read via fetch's Headers (which folds duplicate headers) - split defensively and keep the
// session cookie's name=value pair for the follow-up request.
const sessionCookiePair = setCookie.split(",").map((c) => c.trim().split(";")[0]).join("; ");

console.log("3) getSession (verifying the cookie resolves back to the same user)...");
const session = await auth.api.getSession({
  headers: new Headers({ cookie: sessionCookiePair }),
});
if (!session) throw new Error("getSession returned null — session did not verify");
if (session.user.id !== signUpBody.user.id) {
  throw new Error(
    `getSession resolved to a different user: expected ${signUpBody.user.id}, got ${session.user.id}`,
  );
}

console.log("   OK — session verified for user:", {
  id: session.user.id,
  email: session.user.email,
  sessionId: session.session.id,
  expiresAt: session.session.expiresAt,
});

console.log("\nRound trip complete: signUp -> signIn -> getSession all resolved to the same user.");
