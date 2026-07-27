import { test, expect } from "bun:test";
import { canRead, canWrite, filterReadable, type ScopedUser, type Scoped } from "./scope.ts";

const owner: ScopedUser = { id: "u-owner", isSuperadmin: false, teamIds: ["t1"] };
const teammate: ScopedUser = { id: "u-mate", isSuperadmin: false, teamIds: ["t1"] };
const outsider: ScopedUser = { id: "u-out", isSuperadmin: false, teamIds: ["t2"] };
const superadmin: ScopedUser = { id: "u-admin", isSuperadmin: true, teamIds: [] };

const res = (v: Scoped["visibility"], over: Partial<Scoped> = {}): Scoped =>
  ({ ownerId: "u-owner", teamId: "t1", visibility: v, ...over });

test("company resources are readable by everyone (default-open doctrine)", () => {
  for (const u of [owner, teammate, outsider, superadmin]) expect(canRead(u, res("company"))).toBe(true);
});

test("team resources readable only by team members (+ superadmin)", () => {
  expect(canRead(owner, res("team"))).toBe(true);
  expect(canRead(teammate, res("team"))).toBe(true);
  expect(canRead(outsider, res("team"))).toBe(false);
  expect(canRead(superadmin, res("team"))).toBe(true);
});

test("private resources readable only by owner (+ superadmin) — the hard wall", () => {
  expect(canRead(owner, res("private"))).toBe(true);
  expect(canRead(teammate, res("private"))).toBe(false);
  expect(canRead(outsider, res("private"))).toBe(false);
  expect(canRead(superadmin, res("private"))).toBe(true);
});

test("team resource with null teamId is not team-readable", () => {
  expect(canRead(teammate, res("team", { teamId: null }))).toBe(false);
});

test("canWrite: owner + superadmin always; team member may write a team resource", () => {
  expect(canWrite(owner, res("private"))).toBe(true);
  expect(canWrite(superadmin, res("private"))).toBe(true);
  expect(canWrite(teammate, res("team"))).toBe(true); // documented degrade: any team member
  expect(canWrite(outsider, res("team"))).toBe(false);
  expect(canWrite(teammate, res("private"))).toBe(false); // not owner, not team-visible
});

test("canWrite does NOT fall out of company visibility for a non-owner", () => {
  expect(canWrite(outsider, res("company"))).toBe(false);
  expect(canWrite(owner, res("company"))).toBe(true); // still owner
});

test("filterReadable keeps order and drops unreadable", () => {
  const rows = [res("company"), res("private", { ownerId: "someone-else" }), res("team")];
  expect(filterReadable(teammate, rows)).toEqual([rows[0], rows[2]]);
});
