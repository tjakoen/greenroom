// lib/tests-lib.ts — spec discovery, results, metadata, tags, rename/delete,
// dynamic inputs. Ported from interface/server.js lines 399-465, 750-1043.
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, dirname, basename, sep } from "node:path";
import { ROOT, TESTS_DIR, META_FILE, IS_DEMO, denyInDemo, validTestFile } from "./paths.ts";
import { resultsDir, listRuns } from "./records.ts";

// ------------------------------------------------------------- dynamic inputs
// A recorded test replays literal values every time. Recording the same value
// on replay that same value is submitted every time, which breaks forms with a
// uniqueness constraint (signup email "already exists") or one-time values. The
// "Make inputs dynamic" flow lets the user swap chosen fields for a generator
// from tests/helpers/data.ts, so each run submits a fresh value.
export const INPUT_GENERATORS: Record<string, string> = {
  email: "data.uniqueEmail()",
  name: "data.randomName()",
  text: "data.randomString()",
  id: "data.unique()",
  phone: "data.randomPhone()",
  password: "data.password()",
};

// A `.fill('literal')` on a line, capturing the quoted value (handles escapes).
export const FILL_RE = /\.fill\((['"`])((?:\\.|(?!\1).)*)\1\)/;

// Detect the fillable inputs in a recorded spec: one entry per `.fill('…')`,
// with a best-effort label pulled from the locator on the same line.
export function recordedInputs(rel: unknown): any {
  if (!validTestFile(rel)) return { ok: false, error: "No such test file." };
  const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
  const inputs: { line: number; label: string; value: string }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(FILL_RE);
    if (!m) return;
    const label =
      (line.match(/getBy\w+\(\s*['"`]([^'"`]+)/) || [])[1] ||
      (line.match(/getByRole\([^,]+,\s*\{\s*name:\s*['"`]([^'"`]+)/) || [])[1] ||
      (line.match(/locator\(\s*['"`]([^'"`]+)/) || [])[1] ||
      "(field)";
    inputs.push({ line: i, label, value: m[2] });
  });
  return { ok: true, file: rel, inputs, generators: Object.keys(INPUT_GENERATORS) };
}

// Rewrite chosen fields to a generator call and ensure the data helper is imported.
// `mappings`: [{ line, generator }] where generator is a key of INPUT_GENERATORS
// (or 'keep' to leave a field as recorded).
export function applyInputs(rel: unknown, mappings: { line: number; generator: string }[] | undefined): any {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(rel)) return { ok: false, error: "No such test file." };
  const abs = join(ROOT, rel);
  const lines = readFileSync(abs, "utf8").split("\n");
  let changed = 0;
  for (const { line, generator } of mappings || []) {
    const call = INPUT_GENERATORS[generator];
    if (!call || typeof lines[line] !== "string") continue;
    if (!FILL_RE.test(lines[line])) continue;
    lines[line] = lines[line].replace(FILL_RE, `.fill(${call})`);
    changed++;
  }
  let out = lines.join("\n");
  if (changed && !/from ['"]\.\/helpers\/data['"]/.test(out)) {
    // Add the import right after the first existing import line.
    out = /^import .*$/m.test(out)
      ? out.replace(/^(import .*)$/m, `$1\nimport * as data from './helpers/data';`)
      : `import * as data from './helpers/data';\n` + out;
  }
  writeFileSync(abs, out);
  return { ok: true, changed };
}

// ---------------------------------------------------------- test library
// Discover every runnable spec in tests/ (recursively, ignoring the helpers/
// folder), with the test titles parsed out of each spec and last-run status
// attached. Tests are not tied to an environment.

export function titleFromFileName(file: string): string {
  return basename(file, ".spec.ts")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Pull `test('...')` titles (but not test.describe / hooks) from a spec, plus any
// @tags in the title (Playwright convention — matched by --grep). Returns
// [{ title, tags }].
export function parseTests(absPath: string): { title: string; tags: string[] }[] {
  let src = "";
  try {
    src = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const out: { title: string; tags: string[] }[] = [];
  const re = /\btest(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])(.+?)\1/g;
  let m;
  while ((m = re.exec(src))) {
    const title = m[2];
    const tags = title.match(/@[\w-]+/g) || [];
    out.push({ title, tags });
  }
  return out;
}

// Every *.spec.ts under tests/, recursively, skipping the helpers/ folder.
// Returns repo-relative POSIX paths (e.g. "tests/login.spec.ts").
export function specFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "helpers") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".spec.ts")) {
        out.push(relative(ROOT, abs).split(sep).join("/"));
      }
    }
  };
  walk(TESTS_DIR);
  return out;
}

// The env a Playwright project name encodes, e.g. "chromium (staging)" -> "staging".
export function projectEnv(projectName: string): string {
  const m = /\(([^)]+)\)\s*$/.exec(projectName || "");
  return m ? m[1] : projectName || "";
}

// Flatten Playwright's JSON reporter tree into [{ file, title, env, status, durationMs }].
// A spec run under N projects (a multi-env run) yields N rows — one per env — so
// the UI can show a test × environment matrix. A single-env run yields one row
// per test, exactly as before (with env filled in).
export function flattenSuites(suites: any[], file: string, acc: any[]): any[] {
  for (const s of suites || []) {
    const f = s.file || file;
    for (const spec of s.specs || []) {
      const perProject = spec.tests || [];
      if (perProject.length) {
        for (const t of perProject) {
          const dur = (t.results || []).reduce((n: number, r: any) => n + (r.duration || 0), 0);
          const status = t.status === "skipped" ? "skipped" : t.status === "expected" || t.status === "flaky" ? "passed" : "failed";
          acc.push({ file: spec.file || f, title: spec.title, env: projectEnv(t.projectName), status, durationMs: dur });
        }
      } else {
        acc.push({ file: spec.file || f, title: spec.title, env: "", status: spec.ok ? "passed" : "failed", durationMs: 0 });
      }
    }
    if (s.suites) flattenSuites(s.suites, f, acc);
  }
  return acc;
}

// The role a spec logs in as, read from its first `login('<role>')` call (the role
// baked into the test). '' if it never logs in (a public-page test).
export function specLoginRole(rel: string): string {
  try {
    const m = readFileSync(join(ROOT, rel), "utf8").match(/\blogin\(\s*['"`]([^'"`]+)['"`]/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// Per-test results of a run (default latest), read from results.json.
export function readResults(run?: string): any[] {
  const file = join(resultsDir(run), "results.json");
  if (!existsSync(file)) return [];
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    return flattenSuites(json.suites, "", []);
  } catch {
    return [];
  }
}

// Aggregate every archived run + the latest into per-test history, so the app
// can surface "flaky", "never run", "slowest", last status/duration.
// Keyed two ways: by file+title (precise — disambiguates two tests that share a
// title in different files) and by title alone (fallback for older runs whose
// results.json didn't record a file). listTests prefers the precise key.
export function testHistory(): { byKey: Map<string, any>; byTitle: Map<string, any> } {
  const runs = ["latest", ...listRuns().map((r) => r.id)];
  const byKey = new Map<string, any>();
  const byTitle = new Map<string, any>();
  const accumulate = (map: Map<string, any>, key: string, r: any) => {
    const h = map.get(key) || { statuses: [], lastStatus: null, lastDurationMs: 0, runCount: 0 };
    h.statuses.push(r.status);
    h.runCount++;
    if (h.lastStatus === null) {
      h.lastStatus = r.status;
      h.lastDurationMs = r.durationMs;
    } // 'latest' is first
    map.set(key, h);
  };
  for (const run of runs) {
    for (const r of readResults(run)) {
      accumulate(byTitle, r.title, r);
      if (r.file) accumulate(byKey, `${basename(r.file)}::${r.title}`, r);
    }
  }
  for (const h of [...byKey.values(), ...byTitle.values()]) {
    h.flaky = h.statuses.includes("passed") && h.statuses.includes("failed");
  }
  return { byKey, byTitle };
}

// ---- test metadata sidecar (group / priority / owner / notes), app-managed
export const metaKey = (file: string, title: string) => `${file}::${title}`;

export function loadMeta(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(META_FILE, "utf8"));
  } catch {
    return {};
  }
}
export function saveMeta(file: string, title: string, fields: Record<string, any>): any {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(file)) return { ok: false, error: "No such test file." };
  const meta = loadMeta();
  const key = metaKey(file, title);
  const cur = meta[key] || {};
  for (const k of ["group", "priority", "owner", "notes", "role"]) {
    if (typeof fields[k] === "string") cur[k] = fields[k].trim();
  }
  meta[key] = cur;
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + "\n");
  return { ok: true };
}

// Rewrite a test's @tags. Tags are Playwright's convention — they live in the
// test TITLE (so `--grep` finds them), not in the sidecar — so this edits the
// title string inside the spec file: strip its existing @tags, append the new
// set. Also migrates the sidecar meta key (`file::title`) since the title
// changed. Returns the new title so the caller can re-key.
export function saveTags(file: string, title: string, tags: unknown[]): any {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(file)) return { ok: false, error: "No such test file." };
  // Normalize: '@'-prefixed, [\w-] only, deduped, non-empty.
  const norm = [
    ...new Set(
      (Array.isArray(tags) ? tags : [])
        .map((t) => "@" + String(t).replace(/^@+/, "").replace(/[^\w-]/g, ""))
        .filter((t) => t.length > 1),
    ),
  ];
  const clean = String(title).replace(/\s*@[\w-]+/g, "").trim();
  const newTitle = clean + (norm.length ? " " + norm.join(" ") : "");
  if (newTitle === title) return { ok: true, title, tags: norm }; // nothing to change

  const abs = join(ROOT, file);
  let src;
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    return { ok: false, error: "No such test file." };
  }
  // Replace the exact quoted title in its `test(...)` call. Try each quote style.
  let replaced = false;
  for (const c of ["`", '"', "'"]) {
    const needle = `${c}${title}${c}`;
    const idx = src.indexOf(needle);
    if (idx !== -1) {
      src = src.slice(0, idx) + `${c}${newTitle}${c}` + src.slice(idx + needle.length);
      replaced = true;
      break;
    }
  }
  if (!replaced) return { ok: false, error: "Could not find that test in the file (was it edited elsewhere?). Reload and try again." };
  writeFileSync(abs, src);

  // Carry the sidecar metadata over to the new title.
  try {
    const meta = loadMeta();
    const oldKey = metaKey(file, title);
    const newKey = metaKey(file, newTitle);
    if (meta[oldKey] && oldKey !== newKey) {
      meta[newKey] = meta[oldKey];
      delete meta[oldKey];
      writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + "\n");
    }
  } catch {
    /* meta is best-effort */
  }
  return { ok: true, title: newTitle, tags: norm };
}

// The Tests page payload: one entry per test, enriched with tags (from the file),
// metadata (sidecar) and history (flaky/never-run/last status+duration), plus the
// distinct tag + group lists for the filter bar.
export function listTests(): { tests: any[]; tags: string[]; groups: string[] } {
  const hist = testHistory();
  const meta = loadMeta();
  const tests: any[] = [];
  const tagSet = new Set<string>();
  const groupSet = new Set<string>();
  for (const rel of specFiles()) {
    const parsedRole = specLoginRole(rel); // role baked into the spec's login('…') call
    for (const { title, tags } of parseTests(join(ROOT, rel))) {
      const h = hist.byKey.get(`${basename(rel)}::${title}`) || hist.byTitle.get(title);
      const m = meta[metaKey(rel, title)] || {};
      tags.forEach((t) => tagSet.add(t));
      if (m.group) groupSet.add(m.group);
      tests.push({
        file: rel,
        title,
        cleanTitle: title.replace(/\s*@[\w-]+/g, "").trim(), // title without the @tags
        tags,
        group: m.group || "",
        priority: m.priority || "",
        owner: m.owner || "",
        notes: m.notes || "",
        role: m.role || parsedRole, // login role this test runs as (meta, else parsed from login('…'))
        status: h ? h.lastStatus : null,
        durationMs: h ? h.lastDurationMs : 0,
        flaky: h ? !!h.flaky : false,
        neverRun: !h,
        runCount: h ? h.runCount : 0,
      });
    }
  }
  return { tests, tags: [...tagSet].sort(), groups: [...groupSet].sort() };
}

export function renameTest(file: string, newName: string): any {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(file)) return { ok: false, error: "No such test file." };
  const safe = String(newName || "")
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
  if (!safe) return { ok: false, error: "Enter a valid name." };
  const dir = dirname(join(ROOT, file));
  const dest = join(dir, `${safe}.spec.ts`);
  if (existsSync(dest)) return { ok: false, error: "A test with that name already exists." };
  renameSync(join(ROOT, file), dest);
  const newRel = relative(ROOT, dest).split(sep).join("/");
  migrateMeta(file, newRel); // carry group/priority/owner/notes/role over to the new name
  return { ok: true, file: newRel };
}

// Move (or drop) the sidecar metadata keyed to a spec file when it's renamed or
// deleted — otherwise group/priority/owner/notes/role silently vanish on rename
// and dead entries pile up on delete. Keys are `<file>::<title>`.
export function migrateMeta(oldRel: string, newRel: string | null): void {
  if (IS_DEMO) return;
  try {
    const meta = loadMeta();
    let changed = false;
    for (const key of Object.keys(meta)) {
      if (!key.startsWith(`${oldRel}::`)) continue;
      if (newRel) meta[`${newRel}::${key.slice(oldRel.length + 2)}`] = meta[key];
      delete meta[key];
      changed = true;
    }
    if (changed) writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + "\n");
  } catch {
    /* meta is best-effort */
  }
}

export function deleteTest(file: string): any {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(file)) return { ok: false, error: "No such test file." };
  rmSync(join(ROOT, file));
  migrateMeta(file, null); // drop the orphaned sidecar entries
  return { ok: true };
}
