// Locates an ffmpeg binary so the app can cut a short clip out of a test's
// recording for a bug report. Prefers a system install; falls back to the
// ffmpeg Playwright already downloads for its own video pipeline — so clip
// export works out of the box on any machine that ran `npx playwright install`,
// with no extra dependency added to this project.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

let cached; // undefined = not looked up yet, null = looked up and not found

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

function playwrightCacheDirs() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return [process.env.PLAYWRIGHT_BROWSERS_PATH];
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Caches', 'ms-playwright')];
  if (process.platform === 'win32') return [path.join(home, 'AppData', 'Local', 'ms-playwright')];
  return [path.join(home, '.cache', 'ms-playwright')];
}

function findBundledFfmpeg() {
  const bin = process.platform === 'darwin' ? 'ffmpeg-mac' : process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux';
  for (const dir of playwrightCacheDirs()) {
    if (!fs.existsSync(dir)) continue;
    const revs = fs.readdirSync(dir).filter((n) => n.startsWith('ffmpeg-')).sort().reverse();
    for (const rev of revs) {
      const p = path.join(dir, rev, bin);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function resolveFfmpeg() {
  if (cached !== undefined) return cached;
  cached = which('ffmpeg') || findBundledFfmpeg() || null;
  return cached;
}

// Stream a `-c copy` (no re-encode, fast) clip of `videoFile` from `fromSec` to
// `toSec` straight into a writable stream (an HTTP response). Returns the child
// process, or null if no ffmpeg is available.
function streamClip(videoFile, fromSec, toSec, out) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return null;
  const start = Math.max(0, fromSec);
  const end = Math.max(start + 0.1, toSec);
  // -map_metadata -1 drops the source's container tags (incl. its DURATION tag) —
  // otherwise a `-c copy` remux carries the *original* file's duration forward,
  // even though the clip's actual data is correctly trimmed.
  const proc = spawn(ffmpeg, ['-y', '-ss', String(start), '-to', String(end), '-i', videoFile, '-map_metadata', '-1', '-c', 'copy', '-f', 'webm', 'pipe:1']);
  proc.stdout.pipe(out);
  proc.on('error', () => out.destroy());
  return proc;
}

module.exports = { resolveFfmpeg, streamClip };
