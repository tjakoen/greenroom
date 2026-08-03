// Unit tests for the prefilled "Report a Greenroom bug" URL (lib/report.ts).
//
// The valuable assertions here are the NEGATIVE ones. This body lands on a public issue tracker, so
// the tests that matter are the ones proving what never reaches it: absolute paths (which carry a
// person's name and their employer), environment names, base URLs, run ids, test titles, logins.
// A leak here would be invisible in review, because a diagnostics block always looks innocuous.
import { test, expect } from "bun:test";
import { greenroomIssueUrl, issueBody, GREENROOM_REPO, type Diagnostics } from "./report.ts";

const DIAG: Diagnostics = {
  version: "1.0.0",
  edition: "local (single-user)",
  os: "darwin 25.5.0",
  arch: "arm64",
  runtime: "Bun 1.3.14",
  ffmpeg: true,
};

test("points at Greenroom's own tracker, not the app under test", () => {
  const url = greenroomIssueUrl(DIAG);
  expect(url.startsWith(`https://github.com/${GREENROOM_REPO}/issues/new?`)).toBe(true);
  expect(GREENROOM_REPO).toBe("tjakoen/greenroom");
});

test("carries the diagnostics that change the answer to a bug report", () => {
  const body = issueBody(DIAG);
  for (const v of ["1.0.0", "local (single-user)", "darwin 25.5.0", "arm64", "Bun 1.3.14"]) {
    expect(body).toContain(v);
  }
});

test("body and title are properly encoded, so the link survives being clicked", () => {
  const url = greenroomIssueUrl(DIAG, { title: "Run page shows 4 of 3 & breaks" });
  // Raw spaces/&/# in a query value would truncate or corrupt the prefill.
  const query = url.slice(url.indexOf("?") + 1);
  expect(query).not.toMatch(/ /);
  const parsed = new URLSearchParams(query);
  expect(parsed.get("title")).toBe("Run page shows 4 of 3 & breaks");
  expect(parsed.get("body")).toContain("### What happened");
  expect(parsed.get("labels")).toBe("bug");
});

test("NEVER carries an absolute path — a real ROOT names the person and their employer", () => {
  // The actual shape on the machine this was written on:
  //   /Users/<person>/Documents/Development/<Employer>/platform/greenroom
  const url = greenroomIssueUrl(DIAG);
  const body = decodeURIComponent(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("body")!);
  expect(body).not.toMatch(/\/Users\//);
  expect(body).not.toMatch(/[A-Za-z]:\\/);        // Windows drive path
  expect(body).not.toMatch(/\/home\//);
  expect(body).not.toMatch(/node_modules/);
});

test("NEVER carries env names, base URLs, run ids, test titles or logins", () => {
  // Diagnostics is a closed shape: there is no field these could travel in. This test is the guard
  // that fails if someone later widens it "just to add the active environment" or similar.
  const body = issueBody(DIAG);
  expect(body).not.toMatch(/https?:\/\/(?!github\.com)/);   // no target URLs (github.com links are ours)
  expect(body).not.toMatch(/\.spec\.ts/);                   // no test file names
  // No run id. Match the SHAPE (<iso-stamp>-<env>-<result>), not the bare words: an earlier version
  // of this assertion was /passed|failed/i, which flagged the template's own sentence "if a check
  // failed" and made a correct body look like a leak.
  expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T[\d-]+-[a-z0-9-]+-(passed|failed)/i);
  expect(body).not.toMatch(/password|secret|token/i);
  expect(Object.keys(DIAG).sort()).toEqual(
    ["arch", "edition", "ffmpeg", "os", "runtime", "version"],
  );
});

test("stays inside a clickable URL length even if a field is absurd", () => {
  const huge: Diagnostics = { ...DIAG, os: "x".repeat(20_000) };
  const url = greenroomIssueUrl(huge);
  expect(url.length).toBeLessThanOrEqual(6000);
  // Truncation must still leave a working link, not a dangling percent-escape.
  expect(() => new URL(url)).not.toThrow();
});

test("tells the reporter to check the bundle before attaching it", () => {
  // GitHub has no attachment API, so the zip is a manual drag. The prompt to check it for private
  // data is the only safeguard between a run's logs and a public issue.
  expect(issueBody(DIAG)).toMatch(/check it for anything private/i);
});
