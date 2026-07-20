// lib/audit.ts — append-only audit log over db/schema.ts's `auditLog` table (plans/platform.md
// §4: "every write passes through audit.ts -> auditLog row"). This module NEVER updates or
// deletes a row — accountability requires the trail itself to be tamper-evident; callers only
// ever writeAudit (insert) or listAudit (read).
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { auditLog, id as newId, type AuditSnapshot } from "../db/schema.ts";

// Never store secrets in before/after (plans/platform.md P2 Gate 1 instructions): audit rows are
// destined for a future admin/History "changed by" view (§11 P6) — even an ENCRYPTED secretEnc
// value is sensitive metadata that shouldn't be copied into a second table. Redact any top-level
// key that looks like a secret before the insert.
const SECRET_KEYS = new Set(["secretEnc", "password", "secret"]);

function redact(snapshot: unknown): AuditSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    // Not a plain object — nothing to key-redact; store as-is under a synthetic wrapper isn't
    // worth it here since every real caller passes an entity-shaped object. Cast through unknown.
    return snapshot as AuditSnapshot;
  }
  const out: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (SECRET_KEYS.has(key)) out[key] = "[redacted]";
  }
  return out;
}

export interface AuditEntry {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export interface AuditRow {
  id: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before: AuditSnapshot | null;
  after: AuditSnapshot | null;
  createdAt: Date;
}

/** Inserts one audit row. createdAt is auto (db/schema.ts $defaultFn). Never updates/deletes. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    id: newId(),
    actorId: entry.actorId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    before: redact(entry.before),
    after: redact(entry.after),
  });
}

export interface AuditFilter {
  entity?: string;
  entityId?: string;
  actorId?: string;
  limit?: number;
}

/** Lists audit rows, newest first. */
export async function listAudit(filter: AuditFilter = {}): Promise<AuditRow[]> {
  const conditions = [];
  if (filter.entity) conditions.push(eq(auditLog.entity, filter.entity));
  if (filter.entityId) conditions.push(eq(auditLog.entityId, filter.entityId));
  if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));

  const rows = await db
    .select()
    .from(auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(filter.limit ?? 100);
  return rows;
}
