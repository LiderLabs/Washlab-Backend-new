import { and, desc, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branchMachines } from "../../platform/db/schema/catalog.js";
import { headlines, maintenanceTickets } from "../../platform/db/schema/maintenance.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import { writeAudit } from "../../platform/audit/index.js";
import { ConflictError, NotFoundError } from "../../platform/errors/index.js";
import type { StationContext } from "../../platform/auth/station.js";

type Ticket = typeof maintenanceTickets.$inferSelect;
type RequestMeta = { ip?: string; userAgent?: string };

/** A second tap on "Report" inside this window returns the ticket that was just made instead of a duplicate. */
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

function toTicketDto(t: Ticket, reporter: string | null) {
  return {
    id: t.id,
    branchId: t.branchId,
    machineId: t.machineId,
    machineName: t.machineName,
    displayName: t.displayName,
    serialNumber: t.serialNumber,
    otherDetails: t.otherDetails,
    faultTypes: t.faultTypes,
    description: t.description,
    status: t.status,
    reportedAt: t.reportedAt.toISOString(),
    reportedBy: reporter ?? t.reportedByName,
    fixedAt: t.fixedAt ? t.fixedAt.toISOString() : null,
  };
}

async function reportFault(
  station: StationContext,
  input: { attendantId: string; machineId?: string; machineName?: string; faultTypes: string[]; description?: string },
  meta: RequestMeta
) {
  const faultTypes = [...new Set(input.faultTypes)].sort();

  const { ticket, name, created } = await db.transaction(async (tx) => {
    const [att] = await tx
      .select({ name: attendants.name })
      .from(attendanceLogs)
      .innerJoin(attendants, eq(attendants.id, attendanceLogs.attendantId))
      .where(
        and(
          eq(attendanceLogs.attendantId, input.attendantId),
          eq(attendanceLogs.branchId, station.branchId),
          isNull(attendanceLogs.clockOutAt),
          isNull(attendants.deletedAt),
          eq(attendants.status, "active")
        )
      )
      .limit(1);
    if (!att) throw new ConflictError("Attendant is not clocked in at this branch", "NOT_CLOCKED_IN");

    // The machine's details come from our own table, never from the request.
    let machine: typeof branchMachines.$inferSelect | undefined;
    if (input.machineId) {
      [machine] = await tx
        .select()
        .from(branchMachines)
        .where(
          and(eq(branchMachines.id, input.machineId), eq(branchMachines.branchId, station.branchId), isNull(branchMachines.deletedAt))
        )
        .limit(1);
      if (!machine) throw new NotFoundError("Machine not found at this branch", "MACHINE_NOT_FOUND");
    }
    const machineName = machine?.name ?? input.machineName!;

    // Serialise reports per branch + machine so two tablets can't both pass the duplicate check.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"ticket:" + station.branchId + ":" + (input.machineId ?? machineName)}))`);

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const recent = await tx
      .select()
      .from(maintenanceTickets)
      .where(
        and(
          eq(maintenanceTickets.branchId, station.branchId),
          machine ? eq(maintenanceTickets.machineId, machine.id) : eq(maintenanceTickets.machineName, machineName),
          eq(maintenanceTickets.status, "open"),
          isNull(maintenanceTickets.deletedAt),
          sql`${maintenanceTickets.faultTypes} = ARRAY[${sql.join(faultTypes.map((t) => sql`${t}`), sql`, `)}]::text[]`,
          gte(maintenanceTickets.reportedAt, since)
        )
      )
      .limit(1);
    if (recent[0]) return { ticket: recent[0], name: att.name, created: false };

    const [row] = await tx
      .insert(maintenanceTickets)
      .values({
        branchId: station.branchId,
        machineId: machine?.id,
        machineName,
        displayName: machine?.displayName,
        serialNumber: machine?.serialNumber,
        otherDetails: machine?.otherDetails,
        faultTypes,
        description: input.description || null,
        reportedByAttendantId: input.attendantId,
      })
      .returning();

    await writeAudit(tx, {
      actorId: input.attendantId,
      actorRole: "attendant",
      action: "maintenance.fault_reported",
      entityType: "maintenance_ticket",
      entityId: row!.id,
      changes: { branchId: station.branchId, machineName, faultTypes },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ticket: row!, name: att.name, created: true };
  });

  return { ...toTicketDto(ticket, name), duplicate: !created };
}

async function listTickets(station: StationContext, q: { status?: "open" | "fixed"; limit: number; offset: number }) {
  const condition = and(
    eq(maintenanceTickets.branchId, station.branchId),
    isNull(maintenanceTickets.deletedAt),
    q.status ? eq(maintenanceTickets.status, q.status) : undefined
  );
  const [rows, countRows] = await Promise.all([
    db
    .select({ t: maintenanceTickets, reporter: attendants.name })
    .from(maintenanceTickets)
    .leftJoin(attendants, eq(attendants.id, maintenanceTickets.reportedByAttendantId))
    .where(condition)
    .orderBy(desc(maintenanceTickets.reportedAt), desc(maintenanceTickets.id))
    .limit(q.limit)
    .offset(q.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(maintenanceTickets).where(condition),
  ]);
  return {
    items: rows.map((r) => toTicketDto(r.t, r.reporter)),
    total: countRows[0]?.count ?? 0,
  };
}

/** Notices for this branch: global ones plus this branch's own, not deleted and not expired, newest first. */
async function activeNotices(station: StationContext, query: { limit: number; offset: number }) {
  const condition = and(
    isNull(headlines.deletedAt),
    gt(headlines.expiresAt, new Date()),
    or(isNull(headlines.branchId), eq(headlines.branchId, station.branchId))
  );
  const [rows, countRows] = await Promise.all([
    db
    .select()
    .from(headlines)
    .where(condition)
    .orderBy(desc(headlines.createdAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(headlines).where(condition),
  ]);
  return { items: rows.map((h) => ({
    id: h.id,
    branchId: h.branchId,
    title: h.title,
    body: h.body,
    priority: h.priority,
    expiresAt: h.expiresAt.toISOString(),
    createdAt: h.createdAt.toISOString(),
  })), total: countRows[0]?.count ?? 0 };
}

export const boardService = { reportFault, listTickets, activeNotices };
