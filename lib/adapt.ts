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
// Credentials are deliberately NOT rewritten by adaptSpec — recognising arbitrary sign-in code is
// guesswork, and a wrong guess silently breaks a check or, worse, leaves a password in place while
// claiming it removed it. Those are detected and REPORTED so the UI can name the role the user
// must create.
//
// findSignInSteps/injectLogin below are the "fix" half of that detection: once the user HAS a
// role, they name it and this module wires `await login('<role>')` into the spec in its place —
// still never guessing which fill is the password, only acting once the human has chosen.
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

// The "now records for bug reports" note is identical whether the import swap happens as part of
// adaptSpec or injectLogin below — one literal, so the two can never drift apart.
const IMPORT_NOTE: AdaptNote = {
  kind: "import",
  detail: `Now uses Greenroom's test helpers, so this check records screenshots, console and network for bug reports.`,
};

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
    applied.push(IMPORT_NOTE);
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

// -------------------------------------------------------- the "fix" half: inject a real login

export interface SignInStep {
  index: number; // 0-indexed — matches recordedInputs (lib/tests-lib.ts), which the drop list mirrors
  line: number; // 1-indexed, for display
  text: string; // the trimmed source line
  what: string; // plain English, so a non-coder can judge whether to keep or drop it
}

/** Scan SOURCE line by line for lines that look like a hand-rolled sign-in. One entry per line
 *  max, in source order — a line matching more than one rule is reported once, for the first rule
 *  that fires. Deliberately does NOT match a bare "submit" selector: too many ordinary forms
 *  submit for that alone to mean "sign-in button". */
export function findSignInSteps(src: string): SignInStep[] {
  const gotoRe = /\.goto\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
  const fillRe = /\.(?:fill|type)\(/;
  const envRe = /process\.env\.[A-Z0-9_]*(?:PASS|PWD|USER|LOGIN|CRED)[A-Z0-9_]*/i;
  const clickRe = /\.(?:click|press)\(/;
  const signInWordsRe = /log ?in|sign ?in/i;

  const steps: SignInStep[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    let what: string | null = null;

    const gm = gotoRe.exec(lines[i]);
    if (gm && /login|signin|sign-in|auth/i.test(gm[2])) {
      what = "Opens the sign-in page";
    } else if (envRe.test(lines[i])) {
      what = "Reads a login from an environment variable";
    } else if (fillRe.test(lines[i]) && /pass|pwd/i.test(lines[i])) {
      what = "Types a password";
    } else if (fillRe.test(lines[i]) && /user|email|login|account/i.test(lines[i])) {
      what = "Types a username";
    } else if (clickRe.test(lines[i]) && signInWordsRe.test(lines[i])) {
      what = "Clicks the sign-in button";
    }

    if (what) steps.push({ index: i, line: i + 1, text, what });
  }
  return steps;
}

// A role name is interpolated into a single-quoted string literal below — the server validates it
// against config/roles.json first, but this is the last line of defense against a stray quote (or
// worse) reaching the file on disk.
const ROLE_RE = /^[A-Za-z0-9 ._-]+$/;

// An existing `login('some-role')` call, so re-picking a role RETARGETS the call the check
// already has rather than adding a second one. Only a quoted literal argument is matched: a
// `login(someVariable)` is somebody's own code and is left alone.
const LOGIN_CALL_RE = /\blogin\s*\(\s*(['"`])(?:\\.|(?!\1).)*?\1\s*\)/g;

// A `test('title', async ({ page }) => {` / `test.only(...)` / `test.beforeEach(async ({ page },
// testInfo) => {` header — codegen's own shape, and the common case for hand-written specs too.
// Captures: [1] which of the three it is, [3] the raw fixture-destructure text (possibly empty).
const CALLBACK_RE =
  /\b(test\.beforeEach|test\.only|test)\s*\(\s*(?:(['"`])(?:\\.|(?!\2)[\s\S])*?\2\s*,\s*)?async\s*\(\s*\{([^}]*)\}\s*(?:,\s*[\w$]+\s*)?\)\s*=>\s*\{/g;

interface Callback {
  kind: string;
  headerStart: number;
  headerEnd: number; // one past the callback's opening `{`
  header: string;
  fixtures: string;
}

function findCallbacks(src: string): Callback[] {
  const out: Callback[] = [];
  for (const m of src.matchAll(CALLBACK_RE)) {
    const headerStart = m.index as number;
    out.push({
      kind: m[1],
      headerStart,
      headerEnd: headerStart + m[0].length,
      header: m[0],
      fixtures: (m[3] || "").trim(),
    });
  }
  return out;
}

// Find the `}` that closes the `{` at `openIdx`, skipping braces inside strings/template
// literals/comments so a `{` in a URL or a comment doesn't throw the count off. Best-effort: an
// unbalanced file (should not happen — it wouldn't typecheck as a spec) falls back to EOF.
function matchingBrace(src: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return src.length;
}

/** Inject `await login('<role>')` into a foreign spec, in place of a hand-rolled sign-in. Pure —
 *  same contract as adaptSpec. `dropIndexes` are 0-indexed lines from a prior findSignInSteps call
 *  the user chose to remove (typically the lines findSignInSteps itself flagged). */
export function injectLogin(src: string, rel: string, role: string, dropIndexes?: number[]): AdaptResult {
  const applied: AdaptNote[] = [];
  const attention: AdaptNote[] = [];

  if (!ROLE_RE.test(role)) {
    attention.push({ kind: "credentials", detail: `"${role}" isn't a valid role name, so nothing was changed.` });
    return { code: src, changed: false, applied, attention };
  }

  let out = src;

  // --- 1. drop the ticked sign-in lines FIRST, while the indexes still line up with the source
  // the user was shown (findSignInSteps) — nothing below adds or removes lines before this. -----
  const drop = new Set(dropIndexes || []);
  if (drop.size) {
    out = out
      .split("\n")
      .filter((_, i) => !drop.has(i))
      .join("\n");
    applied.push({
      kind: "credentials",
      detail: `Removed ${drop.size} hand-rolled sign-in step${drop.size === 1 ? "" : "s"} it no longer needs.`,
    });
  }

  // --- 2. point the import at our fixtures — the `login` fixture only exists there -----------
  const spec = fixturesSpecifier(rel);
  const importRe = /(from\s*['"])@playwright\/test(['"])/g;
  if (importRe.test(out)) {
    out = out.replace(importRe, `$1${spec}$2`);
    applied.push(IMPORT_NOTE);
  }

  // --- 3. inject `await login('<role>')` into the right callback(s) --------------------------
  // If ANY test.beforeEach exists, inject only into those (injecting into every test() too would
  // sign in twice — once per test, once per beforeEach). Otherwise inject into every test()/
  // test.only() callback.
  const callbacks = findCallbacks(out);
  const hasBeforeEach = callbacks.some((c) => c.kind === "test.beforeEach");
  const targets = callbacks.filter((c) => (hasBeforeEach ? c.kind === "test.beforeEach" : c.kind !== "test.beforeEach"));

  const edits: { start: number; end: number; text: string }[] = [];
  let injected = 0;
  let retargeted = 0;
  for (const c of targets) {
    const bodyOpen = c.headerEnd - 1; // the callback's opening `{`, the last char of `header`
    const bodyClose = matchingBrace(out, bodyOpen);
    const body = out.slice(bodyOpen + 1, bodyClose);
    // Already signs in through Greenroom: never add a SECOND login — point the existing call at
    // the newly picked role instead. This is what makes "pick a role to change who it signs in
    // as" true; without it, re-picking on an already-wired check silently did nothing.
    if (/\blogin\s*\(/.test(body)) {
      const newBody = body.replace(LOGIN_CALL_RE, `login('${role}')`);
      if (newBody !== body) {
        edits.push({ start: bodyOpen + 1, end: bodyClose, text: newBody });
        retargeted++;
      }
      continue;
    }

    const already = c.fixtures
      .split(",")
      .map((f) => f.trim().split(/\s*:\s*/)[0])
      .includes("login");
    const newFixtures = already ? c.fixtures : c.fixtures ? `${c.fixtures}, login` : "login";
    // Replace only the fixture destructure `{...}`, not the header's own trailing (unmatched-
    // within-header) opening brace — confine the search to after "async (" so a `{` inside a
    // quoted test title can't be mistaken for it.
    const asyncIdx = c.header.search(/async\s*\(/);
    const newHeader = c.header.slice(0, asyncIdx) + c.header.slice(asyncIdx).replace(/\{[^}]*\}/, `{ ${newFixtures} }`);
    edits.push({ start: c.headerStart, end: c.headerEnd, text: `${newHeader}\n  await login('${role}');` });
    injected++;
  }
  // Nothing will end up signing in: bail out with the source UNTOUCHED. Dropping the user's
  // sign-in lines and then failing to add a login would leave a check that can never pass, which
  // is strictly worse than the spec we were handed — so the drop only happens if a login lands.
  if (!injected && !retargeted) {
    return {
      code: src,
      changed: false,
      applied: [],
      attention: [{
        kind: "credentials",
        detail: `Greenroom could not find where this check starts, so nothing was changed. This usually means the check is written in a shape we do not recognise.`,
      }],
    };
  }

  edits.sort((a, b) => b.start - a.start); // apply back-to-front so earlier positions stay valid
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  applied.push({
    kind: "credentials",
    detail: injected
      ? `This check now signs in as "${role}" before it starts.`
      : `This check now signs in as "${role}" instead of the role it used before.`,
  });

  // --- 4. anything that still looks like a hand-rolled sign-in needs the user's eyes ----------
  for (const step of findSignInSteps(out)) {
    attention.push({
      kind: "credentials",
      detail: `Greenroom now signs in first, so this leftover sign-in step (${step.what.toLowerCase()}) may make the check fail on the sign-in screen. Press Login again to drop it.`,
      line: step.line,
    });
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
