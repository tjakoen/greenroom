// spike/monaco/serve.ts — THROWAWAY spike (P0 spike C, plans/platform.md §5).
// Proves monaco-editor's classic AMD self-host assets (node_modules/monaco-editor/min/vs/) can be
// served as plain static files under this repo's no-bundler model and render with a real editor +
// working web workers. NOT wired into server.ts — standalone Bun.serve on a scratch port.
import { join, resolve, sep, extname } from "node:path";

const HERE = import.meta.dir;
const VS_ROOT = resolve(HERE, "..", "..", "node_modules", "monaco-editor", "min", "vs");
const PORT = Number(process.env.SPIKE_PORT || 4910);

// Mirrors @tjakoen/batch/http/static.ts's mime switch, plus the extra types monaco's vs/ tree can
// contain (this build turned out to have ONLY .js + .css under min/vs — no .ttf codicon font, no
// .woff — but a real page must not assume that forever, so map defensively).
function mimeOf(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".js": return "text/javascript";
    case ".css": return "text/css";
    case ".json": return "application/json";
    case ".ttf": return "font/ttf";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".svg": return "image/svg+xml";
    case ".html": return "text/html";
    case ".map": return "application/json"; // sourcemaps — harmless if 404s instead
    default: return "application/octet-stream";
  }
}

async function serveVs(pathname: string): Promise<Response> {
  // pathname is already stripped of the "/vs" prefix by the caller, e.g. "/loader.js".
  const rel = pathname === "/" ? "/loader.js" : pathname;
  const target = resolve(join(VS_ROOT, rel));
  // separator-aware traversal guard (same shape as batch's makeStatic).
  if (target !== VS_ROOT && !target.startsWith(VS_ROOT + sep)) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(target);
  if (!(await file.exists())) return new Response("Not found: " + rel, { status: 404 });
  return new Response(file, { headers: { "Content-Type": mimeOf(target) } });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/" || p === "/index.html") {
      return new Response(Bun.file(join(HERE, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (p.startsWith("/vs/")) return serveVs(p.slice("/vs".length));
    return new Response("Not found", { status: 404 });
  },
});

console.log(`monaco spike ready → http://localhost:${PORT}  (serving ${VS_ROOT} under /vs/)`);
