// Point the db handle at a throwaway file BEFORE anything imports db/index.ts (the DB_PATH const is
// read at module load). Dynamic import below guarantees this assignment runs first.
process.env.GREENROOM_DB_PATH = `/tmp/gr-runscope-test-${process.pid}.db`;
import { test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import type { ScopedUser } from "./scope.ts";

let canReadRun: (u: ScopedUser, runParam: string | null | undefined) => boolean;

beforeAll(async () => {
  const { runAppMigrations, db } = await import("../db/index.ts");
  const { run, runResult, test: testTable } = await import("../db/schema.ts");
  ({ canReadRun } = await import("./run-scope.ts"));

  runAppMigrations();
  // private test owned by userA, covered by run r1 (archived dir "d1"), triggered by userA
  db.insert(testTable).values({ id: "t-priv", title: "Priv", filePath: "tests/p.spec.ts", ownerId: "userA", visibility: "private" }).run();
  db.insert(run).values({ id: "r1", envLabel: "e", status: "failed", triggeredBy: "userA", artifactDir: "d1" }).run();
  db.insert(runResult).values({ id: "rr1", runId: "r1", testId: "t-priv", env: "e", status: "failed" }).run();
  // company test + run r2 (dir "d2")
  db.insert(testTable).values({ id: "t-comp", title: "Comp", filePath: "tests/c.spec.ts", ownerId: "userA", visibility: "company" }).run();
  db.insert(run).values({ id: "r2", envLabel: "e", status: "passed", triggeredBy: "userA", artifactDir: "d2" }).run();
  db.insert(runResult).values({ id: "rr2", runId: "r2", testId: "t-comp", env: "e", status: "passed" }).run();
});

afterAll(() => {
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(process.env.GREENROOM_DB_PATH! + s); } catch {} }
});

const A: ScopedUser = { id: "userA", isSuperadmin: false, teamIds: [] };
const B: ScopedUser = { id: "userB", isSuperadmin: false, teamIds: [] };
const SA: ScopedUser = { id: "admin", isSuperadmin: true, teamIds: [] };

test("non-owner is walled from a private run — by artifactDir and by id", () => {
  expect(canReadRun(B, "d1")).toBe(false);
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

test("unknown / latest / blank selectors fall back to allow (never breaks the normal flow)", () => {
  expect(canReadRun(B, "does-not-exist")).toBe(true);
  expect(canReadRun(B, "latest")).toBe(true);
  expect(canReadRun(B, "")).toBe(true);
  expect(canReadRun(B, null)).toBe(true);
});
