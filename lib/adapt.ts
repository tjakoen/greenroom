// lib/adapt.ts — make a foreign Playwright spec work here, WITHOUT the user opening an editor.
//
// The product promise is "no coding required", so telling someone to hand-edit their imports and
// URLs (as docs/guide/existing-tests.md originally did) defeats the point. Import runs this
// instead. Two transforms already existed inside lib/recorder.ts, hardwired to the record flow
// (cleanRecordedSpec / injectLoginIntoSpec); this generalises them so ANY spec can be adapted:
//
//   1. import swap   `from '@playwright/test'` -> `from '<depth>helpers/fixtures'`
//                    Without it a spec still PASSES but silently produces no filmstrip, no timed
//                    console/network and no pdf-record.json, so Report-a-bug has nothing to show.
//   2. de-hardcode   'https://staging.example.com/checkout' -> '/checkout', but ONLY when the host
//                    matches a configured environment. An unmatched host is left ALONE and
//                    reported: the shipped @example specs deliberately visit public sites
//                    (playwright.dev, wikipedia), and rewriting those would break them.
//
// Credentials are deliberately NOT rewritten. Recognising arbitrary sign-in code is guesswork, and
// a wrong guess silently breaks a check or, worse, leaves a password in place while claiming it
// removed it. Those are detected and REPORTED so the UI can name the role the user must create.
import { basename } from "node:path";

export type AdaptKind =
  | "import"        // pointed at the fixtures (the reporting-critical one)
  | "url"           // absolute -> relative, host matched a configured env
  | "external-url"  // absolute left alone, host is not one of the user's envs
  | "credentials";  // hardcoded sign-in spotted, needs a role

export interface AdaptNote {
  kind: AdaptKind;
  detail: string;
  line?: number; // 1-indexed, for the ones the user may want to look at
}

export interface AdaptResult {
  code: string;
  changed: boolean;
  applied: AdaptNote[]; // what we rewrote
  attention: AdaptNote[]; // what the user still has to do (never silently "fixed")
}

/** `tests/foo.spec.ts` -> `./helpers/fixtures`; `tests/a/b/foo.spec.ts` -> `../../helpers/fixtures`.
 *  Import specifiers are always POSIX, so this joins with "/" rather than path.join. */
export function fixturesSpecifier(rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const inner = clean.startsWith("tests/") ? clean.slice("tests/".length) : clean;
  const depth = inner.split("/").length - 1; // 0 when the spec sits directly in tests/
  return depth === 0 ? "./helpers/fixtures" : "../".repeat(depth) + "helpers/fixtures";
}

/** Hosts we must never rewrite even if a user names an environment after them: the shipped
 *  @example specs navigate these on purpose and are the zero-config green run. */
const EXAMPLE_HOSTS = new Set(["playwright.dev", "www.wikipedia.org", "wikipedia.org", "the-internet.herokuapp.com"]);

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

/** Adapt one spec's SOURCE. Pure: no disk access, so it can run on a zip entry before it is
 *  written, or on a file already in tests/. `baseURLs` are the user's configured environment
 *  addresses (any order; trailing slashes tolerated). */
export function adaptSpec(src: string, rel: string, baseURLs: string[]): AdaptResult {
  const applied: AdaptNote[] = [];
  const attention: AdaptNote[] = [];
  let out = src;

  // --- 1. point the import at our fixtures ------------------------------------------------
  const spec = fixturesSpecifier(rel);
  const importRe = /(from\s*['"])@playwright\/test(['"])/g;
  if (importRe.test(out)) {
    out = out.replace(importRe, `$1${spec}$2`);
    applied.push({
      kind: "import",
      detail: `Now uses Greenroom's test helpers, so this check records screenshots, console and network for bug reports.`,
    });
  }

  // --- 2. absolute -> relative, only for hosts the user actually configured ----------------
  // Longest baseURL first: otherwise "https://x.com" would match before "https://x.com/app" and
  // leave a stray "/app" prefix behind.
  const bases = baseURLs
    .map((b) => String(b || "").trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const b of bases) {
    const escd = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(['"\`])${escd}(/[^'"\`]*)?\\1`, "g");
    let hit = false;
    out = out.replace(re, (_m, q, p) => {
      hit = true;
      return `${q}${p || "/"}${q}`;
    });
    if (hit) {
      applied.push({
        kind: "url",
        detail: `Addresses pointing at ${b} are now relative, so this check runs against whichever site you pick.`,
      });
    }
  }

  // Anything still absolute: leave it, but say so. An external site is legitimate (the @example
  // specs rely on it); an un-configured internal host is the case worth flagging.
  const leftoverRe = /(['"`])(https?:\/\/([^/'"`]+))[^'"`]*\1/g;
  const seenHosts = new Set<string>();
  for (let m: RegExpExecArray | null; (m = leftoverRe.exec(out)); ) {
    const host = m[3];
    if (seenHosts.has(host) || EXAMPLE_HOSTS.has(host)) continue;
    seenHosts.add(host);
    attention.push({
      kind: "external-url",
      detail: `This check goes straight to ${host}, which is not one of your sites, so picking a different site will not change where it looks.`,
      line: lineOf(out, m.index),
    });
  }

  // --- 3. detect (never rewrite) hardcoded sign-in ----------------------------------------
  // Only report when the spec is NOT already using the login fixture.
  if (!/\blogin\s*\(/.test(out)) {
    const credRe = /(process\.env\.[A-Z0-9_]*(?:PASS|PWD|USER|LOGIN|CRED)[A-Z0-9_]*)|(\.fill\s*\(\s*['"`][^'"`]{3,}['"`]\s*\)[^\n]*(?:pass|pwd))/gi;
    const m = credRe.exec(out);
    if (m) {
      attention.push({
        kind: "credentials",
        detail: `This check signs in with its own username and password. Create a role under Roles & logins, then set it as this check's role so Greenroom fills it in per site.`,
        line: lineOf(out, m.index),
      });
    }
  }

  return { code: out, changed: out !== src, applied, attention };
}

/** A one-line, human summary for a toast. `file` is shown so a multi-file import stays readable. */
export function summariseAdapt(rel: string, r: AdaptResult): string {
  const name = basename(rel);
  if (!r.changed && !r.attention.length) return `${name}: ready to run`;
  const bits: string[] = [];
  if (r.applied.some((a) => a.kind === "import")) bits.push("full reporting enabled");
  if (r.applied.some((a) => a.kind === "url")) bits.push("addresses made portable");
  if (r.attention.length) bits.push(`${r.attention.length} thing${r.attention.length === 1 ? "" : "s"} to check`);
  return `${name}: ${bits.join(", ") || "no changes needed"}`;
}
