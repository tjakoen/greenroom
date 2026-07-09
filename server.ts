// greenroom/server.ts — the BREAD composition root: the ONE place BATCH + GRAIN + MILL +
// PROOF + greenroom's own domain meet, mirroring tjakoen.github.io/server.ts.
//
// STATUS: Phase 1 SCAFFOLD (PLAN.md §4, P1). This wires the mounts that port cleanly today —
// PROOF (/plans), MILL (/guide + /context), the local-only security guards, and the
// binary/Range helper — and marks the seams for the mechanical domain port (lib/*.ts) + the
// /api/* handlers + the GRAIN frontend, which land next. Until that port completes, `start`
// still points at interface/server.js (the live app); build THIS root with `bun run dev`
// (`bun --hot server.ts`). See PLAN.md §1–2.
import { join } from "node:path";
import { createMillRoutes, dirSource } from "@tjakoen/mill/serve.ts";
import type { ContentSource } from "@tjakoen/mill/serve.ts";
import { createProofRoutes } from "@tjakoen/proof/routes.ts";
import { guardRequest } from "./lib/guard.ts";

const PORT = Number(Bun.env.PORT ?? 4321);
const HERE = import.meta.dir;

// Minimal P1 page chrome — a bare, valid HTML document. The GRAIN app shell (app-shell +
// tokens + ⌘K/theme islands) wraps these in P2; kept deliberately plain here so the mounts
// can be verified in isolation.
function minimalPage(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>` +
    `<body>${body}</body></html>`;
}

// --- PROOF: greenroom renders its OWN plans/ folder as a board at /plans (proof = a layer). ---
const proofRoutes = createProofRoutes({
  plansDir: join(HERE, "plans"),
  prefix: "/plans",
  chrome: (title, body) => minimalPage(`${title} · Plans`, `<div class="board">${body}</div>`),
});

// --- MILL: the in-app user guide (USER-GUIDE.md) at /guide, and the app-under-test context
// docs (context/*.md) at /context. A one-file source powers /guide; dirSource powers /context. ---
const guideSource: ContentSource = {
  list: async () => ["user-guide"],
  read: async (slug) => (slug === "user-guide" ? await Bun.file(join(HERE, "USER-GUIDE.md")).text() : null),
};
const millRoutes = createMillRoutes({
  chrome: ({ title, body }) => minimalPage(title, body),
  collections: [
    { prefix: "/guide", title: "User guide", source: guideSource },
    { prefix: "/context", title: "App-under-test context", source: dirSource(join(HERE, "context")) },
  ],
});

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // loopback only — this is a local app; never expose it to the LAN.
  async fetch(req) {
    const denied = guardRequest(req);
    if (denied) return denied;

    let p = new URL(req.url).pathname;
    if (p === "/guide") p = "/guide/user-guide"; // the guide is a single doc — serve it at /guide

    const fromProof = await proofRoutes(p);
    if (fromProof) return fromProof;
    const fromMill = await millRoutes(p);
    if (fromMill) return fromMill;

    // --- TODO (Phase 1 domain port, next checkpoint) — these routes still live in
    // interface/server.js and get ported into lib/*.ts: the /api/* handlers (state · run ·
    // stop · record · envs · roles · tests · results · runs · moment · pdf · bug-bundle ·
    // video · …), the run-output SSE moved onto BATCH createStream, the binary static for
    // /report + /runs + images + zips (via lib/binary.ts serveFileRanged), and the
    // GRAIN-rendered pages that replace the interface/ SPA. Also to restore here: the
    // EADDRINUSE self-probe ("already running" vs "another app"). Until then: a clear 501. ---
    if (p === "/" || p.startsWith("/api/") || p.startsWith("/report") || p.startsWith("/runs")) {
      return new Response(
        "Not ported yet (Phase 1 scaffold). This route still lives in interface/server.js.\n" +
          "Run the live app with: bun run start",
        { status: 501, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `greenroom composition root (scaffold) → http://localhost:${PORT}  [PROOF /plans · MILL /guide,/context]`,
);
