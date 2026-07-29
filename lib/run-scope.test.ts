// Point the db handle at a throwaway file BEFORE anything imports db/index.ts (the DB_PATH const is
// read at module load). Dynamic import below guarantees this assignment runs first.
process.env.GREENROOM_DB_PATH = `/tmp/gr-runscope-test-${process.pid}.db`;
import { test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import type { ScopedUser } from "./scope.ts";

let canReadRun: (u: ScopedUser, runParam: string | null | undefined) => boolean;
let canControlRun: (u: ScopedUser, runParam: string | null | undefined) => boolean;

beforeAll(async () => {
  const { runAppMigrations, db } = await import("../db/index.ts");
  const { run, runResult, test: testTable, credential } = await import("../db/schema.ts");
  ({ canReadRun, canControlRun } = await import("./run-scope.ts"));

  runAppMigrations();
  // private test owned by userA, covered by run r1, triggered by userA. artifactDir is stored the
  // way archiveRun really persists it — ROOT-relative WITH the `runs/` prefix — while callers key on
  // the bare basename (the exact mismatch that silently defeated the wall in prod).
  db.insert(testTable).values({ id: "t-priv", title: "Priv", filePath: "tests/p.spec.ts", ownerId: "userA", visibility: "private" }).run();
  // r1 is the NEWEST finished run (latest finishedAt) so `latest`/blank resolves to it.
  db.insert(run).values({ id: "r1", envLabel: "e", status: "failed", triggeredBy: "userA", artifactDir: "runs/d1", finishedAt: new Date(2_000) }).run();
  db.insert(runResult).values({ id: "rr1", runId: "r1", testId: "t-priv", env: "e", status: "failed" }).run();
  // company test + run r2 (dir "runs/d2"), older
  db.insert(testTable).values({ id: "t-comp", title: "Comp", filePath: "tests/c.spec.ts", ownerId: "userA", visibility: "company" }).run();
  db.insert(run).values({ id: "r2", envLabel: "e", status: "passed", triggeredBy: "userA", artifactDir: "runs/d2", finishedAt: new Date(1_000) }).run();
  db.insert(runResult).values({ id: "rr2", runId: "r2", testId: "t-comp", env: "e", status: "passed" }).run();

  // Follow-up B (file-scope wall): a private test whose run_result did NOT link (title drift), but
  // whose spec FILE the run explicitly targeted via scope.files → must still wall a non-owner.
  db.insert(testTable).values({ id: "t-privB", title: "PrivB", filePath: "tests/pb.spec.ts", ownerId: "userA", visibility: "private" }).run();
  db.insert(run).values({ id: "r3", envLabel: "e", status: "passed", triggeredBy: "userA", artifactDir: "runs/d3", finishedAt: new Date(500), scope: { files: ["tests/pb.spec.ts"] } }).run();
  db.insert(runResult).values({ id: "rr3", runId: "r3", testId: "t-comp", env: "e", status: "passed" }).run(); // links only to the COMPANY test

  // Follow-up A (credential-scope wall): a company test run, but the child was handed userA's
  // PRIVATE credential (recorded on scope.credentialIds) → wall a non-owner.
  db.insert(credential).values({ id: "cred-priv", label: "priv", username: "u", secretEnc: "g2:x", ownerId: "userA", visibility: "private" }).run();
  db.insert(run).values({ id: "r4", envLabel: "e", status: "passed", triggeredBy: "userA", artifactDir: "runs/d4", finishedAt: new Date(400), scope: { credentialIds: ["cred-priv"] } }).run();
  db.insert(runResult).values({ id: "rr4", runId: "r4", testId: "t-comp", env: "e", status: "passed" }).run();
});

afterAll(() => {
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(process.env.GREENROOM_DB_PATH! + s); } catch {} }
});

const A: ScopedUser = { id: "userA", isSuperadmin: false, teamIds: [] };
const B: ScopedUser = { id: "userB", isSuperadmin: false, teamIds: [] };
const SA: ScopedUser = { id: "admin", isSuperadmin: true, teamIds: [] };

test("non-owner is walled from a private run — by artifactDir and by id", () => {
  // "d1" is the BARE basename History/bug-report actually send; "runs/d1" is how the DB stores it;
  // "r1" is the run id. All three must wall (the bare-basename form was the prod bypass).
  expect(canReadRun(B, "d1")).toBe(false);
  expect(canReadRun(B, "runs/d1")).toBe(false);
  expect(canReadRun(B, "r1")).toBe(false);
});

test("the triggering user reads their own private run", () => {
  expect(canReadRun(A, "d1")).toBe(true);
});

test("superadmin reads any run", () => {
  expect(canReadRun(SA, "d1")).toBe(true);
});

test("company-visibility run stays open to everyone", () => {
  expect(canReadRun(B, "d2")).toBe(true);
});

test("file-scope wall: a run targeting a private spec file walls a non-owner even if run_result didn't link it", () => {
  expect(canReadRun(B, "d3")).toBe(false); // scope.files -> private tests/pb.spec.ts
  expect(canReadRun(A, "d3")).toBe(true); // owner
  expect(canReadRun(SA, "d3")).toBe(true); // superadmin
});

test("credential-scope wall: a run handed a private credential walls a non-owner", () => {
  expect(canReadRun(B, "d4")).toBe(false); // scope.credentialIds -> userA's private cred
  expect(canReadRun(A, "d4")).toBe(true);
  expect(canReadRun(SA, "d4")).toBe(true);
});

test("unknown run selector falls back to allow (never breaks the normal flow)", () => {
  expect(canReadRun(B, "does-not-exist")).toBe(true);
});

test("latest / blank resolve to the newest run and wall it when private", () => {
  // r1 (private, newest finishedAt) is what `latest`/blank resolve to — a non-owner is walled,
  // NOT waved through by the caller-relative selector (the old bypass).
  expect(canReadRun(B, "latest")).toBe(false);
  expect(canReadRun(B, "")).toBe(false);
  expect(canReadRun(B, null)).toBe(false);
  // the triggerer + superadmin still pass on latest
  expect(canReadRun(A, "latest")).toBe(true);
  expect(canReadRun(SA, "latest")).toBe(true);
});

test("canControlRun: only the triggerer or a superadmin may stop a run", () => {
  expect(canControlRun(A, "d1")).toBe(true); // owner (by bare basename)
  expect(canControlRun(A, "r1")).toBe(true); // owner (by id)
  expect(canControlRun(SA, "d1")).toBe(true); // superadmin
  expect(canControlRun(B, "d1")).toBe(false); // non-owner of a company run — still can't stop it
  expect(canControlRun(B, "d2")).toBe(false);
  // fails closed on non-concrete / unknown targets (no company-open default for a mutation)
  expect(canControlRun(A, "latest")).toBe(false);
  expect(canControlRun(A, "")).toBe(false);
  expect(canControlRun(A, "nope")).toBe(false);
});
