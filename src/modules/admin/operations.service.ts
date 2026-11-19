import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { inventoryItems, notifications } from "../../platform/db/schema/operations.js";
import { maintenanceTickets, headlines } from "../../platform/db/schema/maintenance.js";
import { systemSettings, auditLogs } from "../../platform/db/schema/infrastructure.js";
import { branches } from "../../platform/db/schema/branches.js";
import { BadRequestError, NotFoundError } from "../../platform/errors/index.js";
import type { AuthenticatedUser } from "../../platform/auth/index.js";

type RequestMeta = { ip?: string; userAgent?: string };

async function writeAudit(
  tx: any,
  actor: { id: string; role: string },
  action: string,
  entityType: string,
  entityId: string,
  changes: Record<string, unknown>,
  meta?: RequestMeta
) {
  await tx.insert(auditLogs).values({
    action,
    entityType,
    entityId,
    performedByUserId: actor.id,
    performedByRole: actor.role,
    changes,
    ipAddress: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

export const adminOperationsService = {
  // --- Inventory Management ---
  async listInventory(branchId?: string) {
    const conditions = [isNull(inventoryItems.deletedAt)];
    if (branchId) {
      conditions.push(eq(inventoryItems.branchId, branchId));
    }

    const rows = await db
      .select({
        id: inventoryItems.id,
        branchId: inventoryItems.branchId,
        branchName: branches.name,
        name: inventoryItems.name,
        category: inventoryItems.category,
        unit: inventoryItems.unit,
        description: inventoryItems.description,
        currentStock: inventoryItems.currentStock,
        maxStock: inventoryItems.maxStock,
        minStock: inventoryItems.minStock,
        reorderPoint: inventoryItems.reorderPoint,
        status: inventoryItems.status,
        orderedAt: inventoryItems.orderedAt,
        orderQuantity: inventoryItems.orderQuantity,
        expectedArrivalDate: inventoryItems.expectedArrivalDate,
        lastRestockedAt: inventoryItems.lastRestockedAt,
        createdAt: inventoryItems.createdAt,
      })
      .from(inventoryItems)
      .leftJoin(branches, eq(inventoryItems.branchId, branches.id))
      .where(and(...conditions))
      .orderBy(asc(inventoryItems.name));

    return rows.map((r) => ({
      id: r.id,
      _id: r.id,
      branchId: r.branchId,
      branchName: r.branchName ?? "Unknown Branch",
      name: r.name,
      category: r.category,
      unit: r.unit,
      description: r.description,
      currentStock: r.currentStock,
      maxStock: r.maxStock,
      minStock: r.minStock,
      reorderPoint: r.reorderPoint,
      status: r.status,
      orderedAt: r.orderedAt ? r.orderedAt.toISOString() : null,
      orderQuantity: r.orderQuantity,
      expectedArrivalDate: r.expectedArrivalDate ? r.expectedArrivalDate.toISOString() : null,
      lastRestockedAt: r.lastRestockedAt ? r.lastRestockedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  async createInventoryItem(
    actor: AuthenticatedUser,
    input: {
      branchId: string;
      name: string;
      category: "cleaning_supplies" | "add_ons" | "facility" | "retail" | "operational" | "washing_supplies";
      unit: string;
      description?: string;
      currentStock: number;
      minStock?: number;
      maxStock?: number;
      reorderPoint?: number;
    },
    meta?: RequestMeta
  ) {
    const minStock = input.minStock ?? 5;
    const maxStock = input.maxStock ?? 100;
    const reorderPoint = input.reorderPoint ?? 10;

    let status: "critical" | "low" | "ok" | "ordered" = "ok";
    if (input.currentStock <= 0) status = "critical";
    else if (input.currentStock <= reorderPoint) status = "low";

    return await db.transaction(async (tx) => {
      const [item] = await tx
        .insert(inventoryItems)
        .values({
          branchId: input.branchId,
          name: input.name.trim(),
          category: input.category,
          unit: input.unit.trim(),
          description: input.description?.trim() || null,
          currentStock: input.currentStock,
          minStock,
          maxStock,
          reorderPoint,
          status,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "inventory.created",
        "inventory_item",
        item.id,
        { branchId: item.branchId, name: item.name },
        meta
      );

      return { success: true, id: item.id };
    });
  },

  async updateInventoryItem(
    actor: AuthenticatedUser,
    id: string,
    input: {
      name?: string;
      category?: "cleaning_supplies" | "add_ons" | "facility" | "retail" | "operational" | "washing_supplies";
      unit?: string;
      description?: string;
      currentStock?: number;
      minStock?: number;
      maxStock?: number;
      reorderPoint?: number;
      status?: "critical" | "low" | "ok" | "ordered";
    },
    meta?: RequestMeta
  ) {
    const [existing] = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, id), isNull(inventoryItems.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Inventory item not found", "INVENTORY_ITEM_NOT_FOUND");

    const updates: Partial<typeof inventoryItems.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.category !== undefined) updates.category = input.category;
    if (input.unit !== undefined) updates.unit = input.unit.trim();
    if (input.description !== undefined) updates.description = input.description.trim();
    if (input.minStock !== undefined) updates.minStock = input.minStock;
    if (input.maxStock !== undefined) updates.maxStock = input.maxStock;
    if (input.reorderPoint !== undefined) updates.reorderPoint = input.reorderPoint;
    if (input.status !== undefined) updates.status = input.status;

    if (input.currentStock !== undefined) {
      updates.currentStock = input.currentStock;
      const reorderPoint = input.reorderPoint ?? existing.reorderPoint;
      if (!input.status) {
        if (input.currentStock <= 0) updates.status = "critical";
        else if (input.currentStock <= reorderPoint) updates.status = "low";
        else updates.status = "ok";
      }
    }

    return await db.transaction(async (tx) => {
      const [updated] = await tx.update(inventoryItems).set(updates).where(eq(inventoryItems.id, id)).returning();

      await writeAudit(
        tx,
        actor,
        "inventory.updated",
        "inventory_item",
        id,
        { previous: existing, updated },
        meta
      );

      return { success: true, id: updated.id };
    });
  },

  async deleteInventoryItem(actor: AuthenticatedUser, id: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, id), isNull(inventoryItems.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Inventory item not found", "INVENTORY_ITEM_NOT_FOUND");

    return await db.transaction(async (tx) => {
      await tx
        .update(inventoryItems)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(inventoryItems.id, id));

      await writeAudit(
        tx,
        actor,
        "inventory.deleted",
        "inventory_item",
        id,
        { name: existing.name },
        meta
      );

      return { success: true, id };
    });
  },

  // --- Maintenance Tickets ---
  async listMaintenanceTickets(branchId?: string, status?: string) {
    const conditions = [isNull(maintenanceTickets.deletedAt)];
    if (branchId) {
      conditions.push(eq(maintenanceTickets.branchId, branchId));
    }
    if (status) {
      conditions.push(eq(maintenanceTickets.status, status as "open" | "fixed"));
    }

    const rows = await db
      .select({
        id: maintenanceTickets.id,
        branchId: maintenanceTickets.branchId,
        branchName: branches.name,
        machineId: maintenanceTickets.machineId,
        machineName: maintenanceTickets.machineName,
        displayName: maintenanceTickets.displayName,
        serialNumber: maintenanceTickets.serialNumber,
        otherDetails: maintenanceTickets.otherDetails,
        faultTypes: maintenanceTickets.faultTypes,
        description: maintenanceTickets.description,
        status: maintenanceTickets.status,
        reportedAt: maintenanceTickets.reportedAt,
        reportedBy: maintenanceTickets.reportedByName,
        fixedAt: maintenanceTickets.fixedAt,
        fixedBy: maintenanceTickets.fixedByAdminId,
        createdAt: maintenanceTickets.createdAt,
      })
      .from(maintenanceTickets)
      .leftJoin(branches, eq(maintenanceTickets.branchId, branches.id))
      .where(and(...conditions))
      .orderBy(desc(maintenanceTickets.createdAt))
      .limit(200);

    return rows.map((r) => ({
      id: r.id,
      _id: r.id,
      branchId: r.branchId,
      branchName: r.branchName ?? "Unknown Branch",
      machineId: r.machineId,
      machineName: r.machineName,
      displayName: r.displayName,
      serialNumber: r.serialNumber,
      otherDetails: r.otherDetails,
      faultTypes: r.faultTypes,
      description: r.description,
      status: r.status,
      reportedAt: r.reportedAt.toISOString(),
      reportedBy: r.reportedBy,
      fixedAt: r.fixedAt ? r.fixedAt.toISOString() : null,
      fixedBy: r.fixedBy,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  async markMaintenanceTicketFixed(actor: AuthenticatedUser, ticketId: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(maintenanceTickets)
      .where(and(eq(maintenanceTickets.id, ticketId), isNull(maintenanceTickets.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Ticket not found", "TICKET_NOT_FOUND");

    const now = new Date();

    return await db.transaction(async (tx) => {
      await tx
        .update(maintenanceTickets)
        .set({
          status: "fixed",
          fixedAt: now,
          fixedByAdminId: actor.staffId ? actor.staffId : null,
          updatedAt: now,
        })
        .where(eq(maintenanceTickets.id, ticketId));

      await writeAudit(
        tx,
        actor,
        "maintenance.ticket_fixed",
        "maintenance_ticket",
        ticketId,
        { machineName: existing.machineName },
        meta
      );

      return { success: true, ticketId, status: "fixed" };
    });
  },

  async deleteMaintenanceTicket(actor: AuthenticatedUser, ticketId: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(maintenanceTickets)
      .where(and(eq(maintenanceTickets.id, ticketId), isNull(maintenanceTickets.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Ticket not found", "TICKET_NOT_FOUND");

    return await db.transaction(async (tx) => {
      await tx
        .update(maintenanceTickets)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(maintenanceTickets.id, ticketId));

      await writeAudit(
        tx,
        actor,
        "maintenance.ticket_deleted",
        "maintenance_ticket",
        ticketId,
        { machineName: existing.machineName },
        meta
      );

      return { success: true, ticketId };
    });
  },

  // --- Notifications ---
  async listNotifications(query?: { recipientType?: string; limit?: number }) {
    const limit = query?.limit ?? 50;

    const rows = await db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return rows.map((n) => ({
      id: n.id,
      _id: n.id,
      recipientType: n.recipientType,
      recipientId: n.recipientId,
      branchId: n.branchId,
      title: n.title,
      message: n.message,
      type: n.type,
      priority: n.priority,
      entityType: n.entityType,
      entityId: n.entityId,
      isRead: n.isRead,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      createdAt: n.createdAt.toISOString(),
    }));
  },

  async createNotification(
    actor: AuthenticatedUser,
    input: {
      recipientType: "customer" | "attendant" | "admin" | "station" | "all";
      recipientId?: string;
      branchId?: string;
      title: string;
      message: string;
      type?: string;
      priority?: string;
      entityType?: string;
      entityId?: string;
    },
    meta?: RequestMeta
  ) {
    return await db.transaction(async (tx) => {
      const [n] = await tx
        .insert(notifications)
        .values({
          recipientType: input.recipientType,
          recipientId: input.recipientId || null,
          branchId: input.branchId || null,
          title: input.title.trim(),
          message: input.message.trim(),
          type: input.type || "info",
          priority: input.priority || "normal",
          entityType: input.entityType || null,
          entityId: input.entityId || null,
          isRead: false,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "notification.created",
        "notification",
        n.id,
        { title: n.title, recipientType: n.recipientType },
        meta
      );

      return { success: true, id: n.id };
    });
  },

  async markAllNotificationsRead(actor: AuthenticatedUser) {
    await db
      .update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(eq(notifications.isRead, false));

    return { success: true };
  },

  async deleteNotification(actor: AuthenticatedUser, id: string, meta?: RequestMeta) {
    await db.delete(notifications).where(eq(notifications.id, id));
    return { success: true, id };
  },

  // --- System Settings ---
  async getSystemSettings() {
    const [settings] = await db.select().from(systemSettings).limit(1);
    if (!settings) {
      return {
        id: 1,
        taxRatePercent: 0,
        pointsPerGhs: 1,
        minRedemptionPoints: 100,
        autoLogoutMinutes: 30,
        deliveryPricing: {
          dropoff_self: 0,
          dropoff_delivery: 0,
          pickup_self: 0,
          full_service: 0,
        },
        updatedBy: null,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      id: settings.id,
      taxRatePercent: Number(settings.taxRatePercent),
      pointsPerGhs: settings.pointsPerGhs,
      minRedemptionPoints: settings.minRedemptionPoints,
      autoLogoutMinutes: settings.autoLogoutMinutes,
      updatedBy: settings.updatedBy,
      updatedAt: settings.updatedAt.toISOString(),
    };
  },

  async updateSystemSettings(
    actor: AuthenticatedUser,
    input: {
      taxRatePercent?: number;
      pointsPerGhs?: number;
      minRedemptionPoints?: number;
      autoLogoutMinutes?: number;
    },
    meta?: RequestMeta
  ) {
    const updates: Partial<typeof systemSettings.$inferInsert> = {
      updatedBy: actor.id,
      updatedAt: new Date(),
    };

    if (input.taxRatePercent !== undefined) updates.taxRatePercent = input.taxRatePercent.toString();
    if (input.pointsPerGhs !== undefined) updates.pointsPerGhs = input.pointsPerGhs;
    if (input.minRedemptionPoints !== undefined) updates.minRedemptionPoints = input.minRedemptionPoints;
    if (input.autoLogoutMinutes !== undefined) updates.autoLogoutMinutes = input.autoLogoutMinutes;

    return await db.transaction(async (tx) => {
      await tx
        .insert(systemSettings)
        .values({
          id: 1,
          taxRatePercent: updates.taxRatePercent ?? "0",
          pointsPerGhs: updates.pointsPerGhs ?? 1,
          minRedemptionPoints: updates.minRedemptionPoints ?? 100,
          autoLogoutMinutes: updates.autoLogoutMinutes ?? 30,
          updatedBy: actor.id,
        })
        .onConflictDoUpdate({
          target: systemSettings.id,
          set: updates,
        });

      await writeAudit(
        tx,
        actor,
        "settings.updated",
        "system_settings",
        "1",
        updates,
        meta
      );

      return { success: true };
    });
  },

  // --- Headlines ---
  async listHeadlines(branchId?: string) {
    const conditions = [isNull(headlines.deletedAt)];
    if (branchId) {
      conditions.push(or(eq(headlines.branchId, branchId), isNull(headlines.branchId))!);
    }

    const rows = await db
      .select({
        id: headlines.id,
        branchId: headlines.branchId,
        title: headlines.title,
        body: headlines.body,
        priority: headlines.priority,
        expiresAt: headlines.expiresAt,
        createdAt: headlines.createdAt,
      })
      .from(headlines)
      .where(and(...conditions))
      .orderBy(desc(headlines.createdAt));

    return rows.map((h) => ({
      id: h.id,
      _id: h.id,
      branchId: h.branchId,
      title: h.title,
      body: h.body,
      priority: h.priority,
      expiresAt: h.expiresAt ? h.expiresAt.toISOString() : null,
      createdAt: h.createdAt.toISOString(),
    }));
  },

  async createHeadline(
    actor: AuthenticatedUser,
    input: {
      title: string;
      body?: string;
      branchId?: string;
      priority?: string;
      expiresAt?: string;
    },
    meta?: RequestMeta
  ) {
    return await db.transaction(async (tx) => {
      const [h] = await tx
        .insert(headlines)
        .values({
          title: input.title.trim(),
          body: input.body?.trim() || null,
          branchId: input.branchId || null,
          priority: (input.priority as any) || "info",
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + 7 * 86400000),
          createdByAdminId: actor.staffId ? actor.staffId : null,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "headline.created",
        "headline",
        h.id,
        { title: h.title },
        meta
      );

      return { success: true, id: h.id };
    });
  },

  async deleteHeadline(actor: AuthenticatedUser, id: string, meta?: RequestMeta) {
    await db.update(headlines).set({ deletedAt: new Date() }).where(eq(headlines.id, id));
    return { success: true, id };
  },

  // --- Audit Logs ---
  async listAuditLogs(query?: {
    entityType?: string;
    entityId?: string;
    actorId?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions = [];
    if (query?.entityType) conditions.push(eq(auditLogs.entityType, query.entityType));
    if (query?.entityId) conditions.push(eq(auditLogs.entityId, query.entityId));
    if (query?.actorId) conditions.push(eq(auditLogs.performedByUserId, query.actorId));

    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;

    const rows = await db
      .select()
      .from(auditLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((a) => ({
      id: a.id,
      _id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      performedByUserId: a.performedByUserId,
      performedByRole: a.performedByRole,
      changes: a.changes,
      ipAddress: a.ipAddress,
      userAgent: a.userAgent,
      createdAt: a.createdAt.toISOString(),
    }));
  },
};
