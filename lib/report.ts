// lib/report.ts — "Report a Greenroom bug": build a PREFILLED GitHub issue URL.
//
// Why a prefilled URL and not the API: an API call would need a token, which then needs storing,
// encrypting, scoping per edition and never leaking to the client. A URL needs none of that. The
// person's own browser session authenticates them, GitHub renders its normal new-issue form, and
// they read and edit the body before anything is submitted. Nothing is posted on their behalf.
//
// THE HARD RULE HERE IS WHAT WE DO NOT SEND. This body lands on a PUBLIC issue tracker, so it
// carries only facts about the software, never about the user or the app under test:
//   - NO file paths. The repo's own ROOT on a real machine reads
//     "/Users/<person>/Documents/Development/<Employer>/platform/greenroom" — an absolute path can
//     carry a person's name AND their employer, and it looks harmless in a diagnostics block.
//   - NO environment names or base URLs (config/urls.json is git-ignored precisely because those
//     are private), and NO run ids: a run id is "<stamp>-<env>-<result>", so it embeds an env name.
//   - NO test titles. A spec title is often a feature name from an unreleased internal product.
//   - NO credentials, usernames or role names.
// Everything else the reporter types themselves, in the form, having seen it.
//
// The diagnostics we DO send are the ones that actually change the answer to a bug report: which
// version and edition, which OS and arch, which runtime. See collectDiagnostics in server.ts.

/** The GitHub repo issues land in. Greenroom's own tracker — this feature reports bugs in
 *  GREENROOM, not in the app a user is testing (that is what the /bug page and its bundle are for). */
export const GREENROOM_REPO = "tjakoen/greenroom";

export type Diagnostics = {
  version: string;
  /** "local (single-user)" | "platform (multi-user)" | "demo (read-only)" */
  edition: string;
  os: string;
  arch: string;
  runtime: string;
  ffmpeg: boolean;
};

/** Practical ceiling for the whole URL. Browsers and servers both cap request lines, and GitHub
 *  starts rejecting very long query strings, so a body that grows past this silently produces a
 *  broken link instead of a prefilled form. We stay far under it (the diagnostics block is fixed
 *  size and the template is short), and truncate rather than emit something that will not open. */
const MAX_URL = 6000;

/** A markdown checklist the reporter fills in, plus the diagnostics block. Kept short on purpose:
 *  a wall of prefilled text gets skimmed and submitted unread, which is how a bad report happens. */
export function issueBody(d: Diagnostics): string {
  return [
    "### What happened",
    "",
    "<!-- What you did, and what the app did instead. -->",
    "",
    "### What you expected",
    "",
    "<!-- One line is fine. -->",
    "",
    "### Steps to reproduce",
    "",
    "1. ",
    "2. ",
    "",
    "### Anything else",
    "",
    "<!-- DO NOT attach a bug bundle from a real environment to this issue. This tracker is PUBLIC.",
    "     A bundle contains a Playwright trace, and a trace records network requests WITH HEADERS",
    "     (session cookies, auth tokens) plus a DOM snapshot and video of every page the check",
    "     visited. Against a real app that means live credentials and whatever customer data was on",
    "     screen. If you need to attach evidence, use a bundle from a throwaway or demo environment,",
    "     or paste only the specific error text. GitHub has no attachment API, so any upload here is",
    "     a deliberate manual act by you. -->",
    "",
    "---",
    "",
    "**Diagnostics** (filled in automatically, no URLs or logins included)",
    "",
    "| | |",
    "|---|---|",
    `| Greenroom | ${d.version} |`,
    `| Edition | ${d.edition} |`,
    `| OS | ${d.os} (${d.arch}) |`,
    `| Runtime | ${d.runtime} |`,
    `| ffmpeg | ${d.ffmpeg ? "found" : "not found"} |`,
    "",
  ].join("\n");
}

/** Build the prefilled new-issue URL. Pure: no disk, no network, no process reads, so it is
 *  unit-testable and cannot pick up ambient machine detail by accident. */
export function greenroomIssueUrl(d: Diagnostics, opts: { repo?: string; title?: string } = {}): string {
  const repo = opts.repo ?? GREENROOM_REPO;
  const base = `https://github.com/${repo}/issues/new`;
  const title = opts.title ?? "";
  let body = issueBody(d);

  const build = (b: string) => {
    const q = new URLSearchParams({ labels: "bug" });
    if (title) q.set("title", title);
    q.set("body", b);
    return `${base}?${q.toString()}`;
  };

  let url = build(body);
  if (url.length > MAX_URL) {
    // Trimming the BODY by the overshoot does not work: the body is percent-encoded into the URL, so
    // one dropped character can remove three URL characters (or one), and a naive subtraction lands
    // either over the cap or needlessly short. Binary-search the largest prefix whose ENCODED url
    // fits, measuring the real thing each time.
    const marker = "\n\n<!-- truncated, see the diagnostics table above -->\n";
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (build(body.slice(0, mid) + marker).length <= MAX_URL) lo = mid;
      else hi = mid - 1;
    }
    // Never cut through a surrogate pair: a lone half would encode as an invalid sequence.
    let cut = body.slice(0, lo);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    url = build(cut + marker);
  }
  return url;
}
