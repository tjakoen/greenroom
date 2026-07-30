// lib/tests-share.ts — export/import a set of tests as one .zip so LOCAL users can share checks
// with each other (a test is a tests/*.spec.ts file; its group/priority/owner/notes/role live in
// the git-ignored sidecar tests-meta.json and would NOT travel with a bare file copy). The zip
// carries the spec files, any tests/helpers/*.ts they import, and a manifest with the matching
// tests-meta.json entries. Import merges it all back, guarding against zip-slip and name clashes.
//
// Uses the existing zero-dep STORE writer (lib/zip.ts) for export. Import parses both STORE and
// DEFLATE entries (node:zlib) so a zip re-made by any tool still imports.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, normalize, sep, dirname, basename } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ROOT, TESTS_DIR, META_FILE } from "./paths.ts";
import { zipStore, type ZipEntry } from "./zip.ts";
import { loadMeta, metaKey, specFiles } from "./tests-lib.ts";

const MANIFEST = "greenroom-tests.json";

interface Manifest {
  version: 1;
  files: string[];
  meta: Record<string, any>;
}

/** A ROOT-relative path is a legal share target only if it normalizes to a real path INSIDE
 *  tests/ and is either a *.spec.ts or a tests/helpers/*.ts. Blocks zip-slip (`../`, absolute). */
function safeShareRel(rel: string): string | null {
  if (typeof rel !== "string" || !rel) return null;
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const abs = normalize(join(ROOT, clean));
  if (!abs.startsWith(TESTS_DIR + sep)) return null; // outside tests/ → reject
  const isSpec = clean.endsWith(".spec.ts");
  const isHelper = clean.startsWith("tests/helpers/") && clean.endsWith(".ts");
  return isSpec || isHelper ? clean : null;
}

/** The tests/helpers/*.ts files a spec imports (best-effort scan of `from '.../helpers/x'`). */
function helpersImportedBy(specRel: string): string[] {
  const abs = join(ROOT, specRel);
  if (!existsSync(abs)) return [];
  const src = readFileSync(abs, "utf8");
  const out = new Set<string>();
  const re = /from\s+['"](?:\.\.?\/)*helpers\/([\w.-]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1].endsWith(".ts") ? m[1] : `${m[1]}.ts`;
    const rel = `tests/helpers/${name}`;
    if (existsSync(join(ROOT, rel))) out.add(rel);
  }
  return [...out];
}

/** Build a shareable .zip from the given spec files (ROOT-relative, e.g. "tests/foo.spec.ts").
 *  Includes each spec, the helpers it imports, and a manifest with the matching meta entries. */
export function exportTests(rels: string[]): Buffer {
  const specs = Array.from(new Set(rels.map(safeShareRel).filter((r): r is string => !!r && r.endsWith(".spec.ts"))));
  const meta = loadMeta();
  const entries: ZipEntry[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    if (seen.has(rel)) return;
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    seen.add(rel);
    entries.push({ name: rel, data: readFileSync(abs) });
    files.push(rel);
  };
  for (const spec of specs) {
    add(spec);
    for (const h of helpersImportedBy(spec)) add(h);
  }
  // manifest: only the meta entries belonging to the exported specs (key is `<rel>::<title>`).
  const pickedMeta: Record<string, any> = {};
  for (const [key, val] of Object.entries(meta)) {
    const file = key.split("::")[0];
    if (specs.includes(file)) pickedMeta[key] = val;
  }
  const manifest: Manifest = { version: 1, files: specs, meta: pickedMeta };
  entries.push({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
  return zipStore(entries);
}

// ---- minimal zip reader (STORE + DEFLATE) --------------------------------------------------
interface RawEntry { name: string; data: Buffer }
function zipRead(buf: Buffer): RawEntry[] {
  // Find End Of Central Directory (scan backwards for its signature).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const out: RawEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central dir header
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42); // local header offset
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // Jump to the local header to find where the data actually starts.
    const lhNameLen = buf.readUInt16LE(lho + 26);
    const lhExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression method ${method} for ${name}.`);
    if (!name.endsWith("/")) out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export interface ImportResult {
  ok: true;
  written: string[];
  skipped: string[]; // existed already (not overwritten)
  rejected: string[]; // unsafe path / wrong type
  metaMerged: number;
}

/** Import a shareable .zip: write its spec + helper files into tests/ and merge the manifest's
 *  meta entries into tests-meta.json. Existing files are skipped unless `overwrite` is set. */
export function importTests(buf: Buffer, opts: { overwrite?: boolean } = {}): ImportResult {
  const raw = zipRead(buf);
  const written: string[] = [];
  const skipped: string[] = [];
  const rejected: string[] = [];
  let manifest: Manifest | null = null;

  for (const e of raw) {
    if (e.name === MANIFEST) {
      try { manifest = JSON.parse(e.data.toString("utf8")); } catch { /* ignore a bad manifest */ }
      continue;
    }
    const rel = safeShareRel(e.name);
    if (!rel) { rejected.push(e.name); continue; }
    const abs = join(ROOT, rel);
    if (existsSync(abs) && !opts.overwrite) { skipped.push(rel); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, e.data);
    written.push(rel);
  }

  // Merge meta — only for files we actually wrote, and re-key defensively to the written rel so a
  // manifest authored elsewhere can't inject meta for arbitrary keys.
  let metaMerged = 0;
  if (manifest?.meta && written.length) {
    const meta = loadMeta();
    const writtenSet = new Set(written);
    for (const [key, val] of Object.entries(manifest.meta)) {
      const file = key.split("::")[0];
      const title = key.slice(file.length + 2);
      if (!writtenSet.has(file) || !title) continue;
      meta[metaKey(file, title)] = val;
      metaMerged++;
    }
    if (metaMerged) writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + "\n");
  }

  return { ok: true, written, skipped, rejected, metaMerged };
}

/** All exportable spec files (ROOT-relative) — used when the UI exports "all". */
export function allSpecRels(): string[] {
  return specFiles().filter((r) => r.endsWith(".spec.ts") && basename(r) !== MANIFEST);
}
