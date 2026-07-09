// lib/ffmpeg.ts — Locates an ffmpeg binary so the app can cut a short clip out of a test's
// recording for a bug report. Prefers a system install; falls back to the
// ffmpeg Playwright already downloads for its own video pipeline — so clip
// export works out of the box on any machine that ran `npx playwright install`,
// with no extra dependency added to this project.
// Ported from interface/ffmpeg.js. streamClip(...,res) (Node response pipe) is
// replaced by clipStream(...) returning a web ReadableStream — there is no `res`
// in bun; server.ts wraps the stream in `new Response(clipStream(...), {headers})`.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Readable } from "node:stream";

let cached: string | null | undefined; // undefined = not looked up yet, null = looked up and not found

function which(cmd: string): string | null {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

function playwrightCacheDirs(): string[] {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return [process.env.PLAYWRIGHT_BROWSERS_PATH];
  const home = homedir();
  if (process.platform === "darwin") return [join(home, "Library", "Caches", "ms-playwright")];
  if (process.platform === "win32") return [join(home, "AppData", "Local", "ms-playwright")];
  return [join(home, ".cache", "ms-playwright")];
}

function findBundledFfmpeg(): string | null {
  const bin = process.platform === "darwin" ? "ffmpeg-mac" : process.platform === "win32" ? "ffmpeg-win64.exe" : "ffmpeg-linux";
  for (const dir of playwrightCacheDirs()) {
    if (!existsSync(dir)) continue;
    const revs = readdirSync(dir).filter((n) => n.startsWith("ffmpeg-")).sort().reverse();
    for (const rev of revs) {
      const p = join(dir, rev, bin);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export function resolveFfmpeg(): string | null {
  if (cached !== undefined) return cached;
  cached = which("ffmpeg") || findBundledFfmpeg() || null;
  return cached;
}

// Stream a `-c copy` (no re-encode, fast) clip of `videoFile` from `fromSec` to
// `toSec` as a web ReadableStream (the caller wraps it in a Response). Returns
// null if no ffmpeg is available.
export function clipStream(videoFile: string, fromSec: number, toSec: number): ReadableStream<Uint8Array> | null {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return null;
  const start = Math.max(0, fromSec);
  const end = Math.max(start + 0.1, toSec);
  // -map_metadata -1 drops the source's container tags (incl. its DURATION tag) —
  // otherwise a `-c copy` remux carries the *original* file's duration forward,
  // even though the clip's actual data is correctly trimmed.
  const proc = spawn(ffmpeg, ["-y", "-ss", String(start), "-to", String(end), "-i", videoFile, "-map_metadata", "-1", "-c", "copy", "-f", "webm", "pipe:1"]);
  proc.on("error", () => {
    /* surfaced to the consumer via the stream erroring/ending; nothing to pipe into anymore */
  });
  return Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
}
