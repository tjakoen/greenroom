// lib/binary.ts — byte-preserving static + HTTP Range/206 serving under bun.
// BATCH's makeStatic text-reads files, which corrupts binaries (the portfolio's woff2/font
// lesson — see PLAN §1). So report/runs/images/zips and /api/video are served here via
// Bun.file, which preserves bytes. Range support is what makes <video> scrubbing/seeking
// work: the browser sends `Range` and expects a 206 partial + Content-Range. Ported from
// interface/server.js serveRanged (fs.createReadStream → Bun.file.slice) with the same math.
import { normalize, resolve, join, sep, extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webm": "video/webm", ".mp4": "video/mp4",
  ".zip": "application/zip", ".pdf": "application/pdf", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
export const mimeOf = (p: string): string => MIME[extname(p).toLowerCase()] ?? "application/octet-stream";

/** Resolve `rel` under `root`, or null if it escapes (traversal guard). Mirrors the
 *  portfolio serveFont + server.js report-dir checks: the resolved path must equal `root`
 *  or sit beneath `root + sep`, so a sibling like ".../playwright-report-evil" can't pass. */
export function safeResolve(root: string, rel: string): string | null {
  const base = resolve(root);
  const fp = resolve(normalize(join(base, rel)));
  if (fp !== base && !fp.startsWith(base + sep)) return null;
  return fp;
}

/** Serve a file with byte-preserving reads + HTTP Range support (200 / 206 / 416), 404 when
 *  missing. Same Content-Range/Content-Length semantics as server.js serveRanged. */
export async function serveFileRanged(req: Request, absPath: string, contentType?: string): Promise<Response> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const size = file.size;
  const type = contentType ?? mimeOf(absPath);
  const range = req.headers.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(file, {
    status: 200,
    headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" },
  });
}
