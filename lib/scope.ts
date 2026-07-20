// lib/scope.ts — pure authorization helpers (plans/platform.md §4, "Scoping & authorization").
// Framework-agnostic on purpose: no DB, no HTTP, no better-auth import here. A future P2 UI gate's
// /api/* handler resolves a ScopedUser (via auth/index.ts getSessionUser()) and a Scoped resource
// (via its own table row) and calls these — this module never reaches for either itself.
//
// Company-internal reality (plans/platform.md §0, §4): single company, everyone may read
// everything by default. New shareable resources default to visibility:'company' (db/schema.ts
// column default) — canRead/canWrite exist for *accountability and narrowing*, not a hard
// security wall between teammates. Superadmins bypass both.

/** The session user shape scope checks consume. Populated by auth/index.ts's getSessionUser() —
 *  isSuperadmin from the admin plugin's `user.role` column, teamIds from the organization
 *  plugin's `teamMember` table (plans/platform.md §3 "table ownership" box). */
export interface ScopedUser {
  id: string;
  isSuperadmin: boolean;
  teamIds: string[];
  /** Optional per-team role map (teamId -> role), IF the org plugin cleanly exposed team-scoped
   *  roles for this user. Not populated today — better-auth's `teamMember` table has no `role`
   *  column (only org-level `member.role` does, which isn't per-team). Reserved for if/when a
   *  per-team role is added; canWrite below does NOT rely on it (see its TODO). */
  teamRoles?: Record<string, string>;
}

/** The minimal shape any shareable resource row must carry to be scope-checked (environment,
 *  credential, role, envGroup, test, run — db/schema.ts). */
export interface Scoped {
  ownerId: string;
  teamId: string | null;
  visibility: "private" | "team" | "company";
}

/** plans/platform.md §4, verbatim:
 *  canRead(user, r) = user.isSuperadmin
 *                  || r.visibility === 'company'
 *                  || (r.visibility === 'team'    && user.teams.includes(r.teamId))
 *                  || (r.visibility === 'private' && r.ownerId === user.id)
 *
 *  Note: rows imported by P1 are `ownerId:'system', visibility:'company'` — the second clause
 *  (visibility === 'company') makes them readable by everyone regardless of ownerId, so that
 *  falls out of these rules with no special case needed. */
export function canRead(user: ScopedUser, r: Scoped): boolean {
  if (user.isSuperadmin) return true;
  if (r.visibility === "company") return true;
  if (r.visibility === "team") return r.teamId !== null && user.teamIds.includes(r.teamId);
  // r.visibility === "private"
  return r.ownerId === user.id;
}

/** plans/platform.md §4:
 *  canWrite(user, r) = user.isSuperadmin || r.ownerId === user.id
 *                   || (r.visibility === 'team' && teamRole(user, r.teamId) === 'owner')
 *
 *  Simplified per the gate's instructions: better-auth's organization plugin (teams:{enabled:true})
 *  does not expose a per-team owner role — its `teamMember` table is just (teamId, userId,
 *  createdAt); only `member.role` carries a role, and that's ORG-scoped (owner/admin/member), not
 *  team-scoped (verified by reading node_modules/better-auth's organization plugin schema, P2
 *  Gate 1). So "team-owner" degrades to "any member of that team" here.
 *  TODO tighten team-write to team-owners once/if a per-team role is exposed (see ScopedUser.teamRoles). */
export function canWrite(user: ScopedUser, r: Scoped): boolean {
  if (user.isSuperadmin) return true;
  if (r.ownerId === user.id) return true;
  if (r.visibility === "team" && r.teamId !== null && user.teamIds.includes(r.teamId)) return true;
  return false;
}

/** Convenience: filters a list of scoped rows down to the ones `user` can read, preserving order. */
export function filterReadable<T extends Scoped>(user: ScopedUser, rows: T[]): T[] {
  return rows.filter((r) => canRead(user, r));
}
