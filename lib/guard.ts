// lib/guard.ts — greenroom's local-only security guards, ported verbatim from
// interface/server.js (BATCH ships none of these; see PLAN §1). This is a LOCAL app: it
// binds loopback only, but a malicious page in the user's own browser can still try to
// reach it, and a domain resolving to 127.0.0.1 (DNS-rebinding) can send a foreign Host
// header. These checks close both — only loopback Hosts are served, and cross-origin
// writes are rejected — plus a JSON content-type gate on bodied POSTs.

/** Loopback-only Host allowlist — blocks DNS-rebinding (a domain pointing at 127.0.0.1
 *  sends its own Host header). Empty host is allowed: some clients omit it and the loopback
 *  bind already gates reachability. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return true;
  const h = String(host).replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

/** True when `origin` parses to a loopback host. Unparseable → false (a foreign write). */
export function isLoopbackOrigin(origin: string | null | undefined): boolean {
  try {
    return isLoopbackHost(new URL(origin as string).host);
  } catch {
    return false;
  }
}

/** Deployment allowlist (platform): the host(s) this instance is served on behind a reverse
 *  proxy. Set ALLOWED_HOSTS (comma-separated, e.g. "greenroom.example.com") to serve a real
 *  domain. UNSET → loopback-only, i.e. today's local-app behavior is completely unchanged.
 *  NOTE: this widens the anti-DNS-rebinding/CSRF surface — a deployed instance must sit behind
 *  a TLS-terminating proxy + rely on better-auth sessions; a full deploy security review is
 *  tracked in plans/platform.md §10 (DEPLOY.md). */
function allowedHosts(): string[] {
  return String(process.env.ALLOWED_HOSTS || "")
    .split(",").map((s) => s.trim().replace(/^https?:\/\//, "").replace(/:\d+$/, "").toLowerCase()).filter(Boolean);
}
export function isAllowedHost(host: string | null | undefined): boolean {
  const allow = allowedHosts();
  if (allow.length > 0) {
    // Deployed instance: require an explicit, allowlisted Host. A trusted proxy always sets one, so
    // a missing/empty Host — or a wildcard bind address like 0.0.0.0 that isLoopbackHost() otherwise
    // treats as loopback — is NOT a legitimate client and must be rejected (else the loopback
    // allowance becomes a blanket bypass on a public instance). Only genuine loopback names + the
    // configured hosts pass.
    if (!host) return false;
    const h = String(host).replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
    return allow.includes(h);
  }
  // Local edition: loopback-only. Empty host allowed (some clients omit it; the loopback bind
  // already gates reachability).
  if (isLoopbackHost(host)) return true;
  if (!host) return true;
  const h = String(host).replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return allow.includes(h);
}
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (isLoopbackOrigin(origin)) return true;
  try {
    return isAllowedHost(new URL(origin as string).host);
  } catch {
    return false;
  }
}

/** Apply the three local-only guards to an incoming request. Returns a rejecting Response
 *  when the request must be refused, or null when it is allowed through. Mirrors
 *  interface/server.js lines 1478–1504 exactly (Node http → Fetch API). */
export function guardRequest(req: Request): Response | null {
  // Serve loopback Hosts only (or the configured ALLOWED_HOSTS on a deployed instance).
  if (!isAllowedHost(req.headers.get("host"))) {
    return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
  }
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    // Reject cross-origin writes (CSRF): a state-changing request carrying an Origin that is
    // neither loopback nor an allowed deployment host is a foreign page poking our API. Our own
    // UI sends a same-origin Origin (or none).
    const origin = req.headers.get("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return Response.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 });
    }
    // A POST that carries a body must declare JSON. This blocks a cross-origin "simple" form
    // post (which can only set text/plain and skips preflight). Bodyless POSTs are fine.
    // (server.js keyed on content-length>0; the Fetch equivalent is a present body — real
    // incoming requests still send content-length, but a bodyless POST has req.body === null.)
    if (method === "POST" && req.body != null) {
      const ct = String(req.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("application/json")) {
        return Response.json({ ok: false, error: "Expected application/json." }, { status: 415 });
      }
    }
  }
  return null;
}
