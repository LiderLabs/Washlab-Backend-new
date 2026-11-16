import { db } from "../db/index.js";
import { auditLogs } from "../db/schema/infrastructure.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbExecutor = typeof db | Tx;

export type AuditEntry = {
  actorId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  /** Allowlisted fields only. Never put PINs, tokens or hashes in here. */
  changes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
};

export async function writeAudit(executor: DbExecutor, entry: AuditEntry) {
  await executor.insert(auditLogs).values({
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    performedByUserId: entry.actorId,
    performedByRole: entry.actorRole,
    changes: entry.changes,
    ipAddress: entry.ipAddress?.slice(0, 45),
    userAgent: entry.userAgent?.slice(0, 255),
  });
}
