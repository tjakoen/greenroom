// auth/bootstrap.ts — single default organization + team bootstrap (plans/platform.md §2:
// "single company = a single default organization; users belong to it; teams are sub-groups
// within it").
//
// Queries better-auth's own `organization`/`team`/`member`/`teamMember` tables DIRECTLY over the
// shared `sqlite` handle (db/index.ts) rather than through auth.api.* — those tables aren't in
// our Drizzle schema (db/schema.ts only owns the app tables per plans/platform.md §3's "table
// ownership" box), and calling auth.api.* here would need a fabricated session/request. Real
// column names below were verified by running better-auth's own migration runner against a
// scratch db and reading `PRAGMA table_info` (P2 Gate 1) — not guessed:
//   organization(id, name, slug, logo, createdAt, metadata)
//   team(id, name, organizationId, createdAt, updatedAt)
//   member(id, organizationId, userId, role, createdAt)
//   teamMember(id, teamId, userId, createdAt)
import { sqlite } from "../db/index.ts";

const DEFAULT_TEAM_NAME = "Unassigned";

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "company";
}

export interface DefaultOrg {
  id: string;
  teamId: string;
}

/** Ensures exactly one `organization` row exists (name from COMPANY_NAME, default "Company") and
 *  a default "Unassigned" `team` within it. Idempotent — safe to call every boot; a second call
 *  finds the existing rows and creates nothing. */
export function ensureDefaultOrg(): DefaultOrg {
  const existingOrg = sqlite.query("SELECT id FROM organization LIMIT 1").get() as { id: string } | null;
  let orgId: string;
  if (existingOrg) {
    orgId = existingOrg.id;
  } else {
    orgId = crypto.randomUUID();
    const name = process.env.COMPANY_NAME ?? "Company";
    sqlite
      .query("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)")
      .run(orgId, name, slugify(name), Date.now());
  }

  const existingTeam = sqlite
    .query("SELECT id FROM team WHERE organizationId = ? AND name = ? LIMIT 1")
    .get(orgId, DEFAULT_TEAM_NAME) as { id: string } | null;
  let teamId: string;
  if (existingTeam) {
    teamId = existingTeam.id;
  } else {
    teamId = crypto.randomUUID();
    sqlite
      .query("INSERT INTO team (id, name, organizationId, createdAt) VALUES (?, ?, ?, ?)")
      .run(teamId, DEFAULT_TEAM_NAME, orgId, Date.now());
  }
  return { id: orgId, teamId };
}

/** Adds `userId` as a member of the default org + default "Unassigned" team (creating both if
 *  this is somehow the first call of the boot). Idempotent per user — checks membership first. */
export function joinDefaultOrg(userId: string): void {
  const { id: orgId, teamId } = ensureDefaultOrg();

  const existingMember = sqlite
    .query("SELECT id FROM member WHERE organizationId = ? AND userId = ?")
    .get(orgId, userId);
  if (!existingMember) {
    sqlite
      .query("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), orgId, userId, "member", Date.now());
  }

  const existingTeamMember = sqlite
    .query("SELECT id FROM teamMember WHERE teamId = ? AND userId = ?")
    .get(teamId, userId);
  if (!existingTeamMember) {
    sqlite
      .query("INSERT INTO teamMember (id, teamId, userId, createdAt) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), teamId, userId, Date.now());
  }
}

/** All team ids `userId` belongs to (drives ScopedUser.teamIds — lib/scope.ts). */
export function getTeamIds(userId: string): string[] {
  const rows = sqlite.query("SELECT teamId FROM teamMember WHERE userId = ?").all(userId) as Array<{
    teamId: string;
  }>;
  return rows.map((r) => r.teamId);
}

/** Total user count — used by the databaseHooks before-hook (auth/index.ts) to promote the
 *  FIRST user created to superadmin as a bootstrap safety net, even without SUPERADMIN_EMAIL set. */
export function countUsers(): number {
  const row = sqlite.query("SELECT COUNT(*) as c FROM user").get() as { c: number };
  return row.c;
}

/** True when `email` matches the configured SUPERADMIN_EMAIL (case-insensitive). False (never
 *  throws) when the env var isn't set. */
export function isSuperadminEmail(email: string): boolean {
  const configured = process.env.SUPERADMIN_EMAIL;
  if (!configured) return false;
  return email.toLowerCase() === configured.toLowerCase();
}
