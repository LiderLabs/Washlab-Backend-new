import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches, Branch } from "../../platform/db/schema/branches.js";
import { branchMachines, branchServices, services } from "../../platform/db/schema/catalog.js";
import { attendants, attendanceLogs } from "../../platform/db/schema/staff.js";
import { orders } from "../../platform/db/schema/orders.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../platform/errors/index.js";
import { hashSecret } from "../../platform/crypto/index.js";
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

function toBranchDto(b: Branch, stats?: { activeAttendantsCount: number; todayOrdersCount: number; machinesCount: number }) {
  const pricingPerKg = Number(b.pricingPerKgPesewas) / 100;
  const deliveryFee = Number(b.deliveryFeePesewas) / 100;
  return {
    id: b.id,
    _id: b.id,
    name: b.name,
    code: b.code,
    terminalId: b.terminalId,
    phoneNumber: b.phoneNumber,
    email: b.email,
    address: b.address,
    city: b.city,
    pricingPerKg,
    pricingPerKgPesewas: b.pricingPerKgPesewas.toString(),
    deliveryFee,
    deliveryFeePesewas: b.deliveryFeePesewas.toString(),
    deliveryFees: b.deliveryFees ?? null,
    requireStationLogin: b.requireStationLogin,
    weeklyOrderTarget: b.weeklyOrderTarget,
    momoNumber: b.momoNumber,
    isActive: b.isActive,
    createdAt: b.createdAt.toISOString(),
    stats,
  };
}

export const adminBranchesService = {
  // --- Branches ---
  async listBranches(
    includeInactive: boolean = false,
    pagination: { limit?: number; offset?: number } = {}
  ) {
    const conditions = [isNull(branches.deletedAt)];
    if (!includeInactive) {
      conditions.push(eq(branches.isActive, true));
    }

    const [branchList, countRows] = await Promise.all([
      db
      .select()
      .from(branches)
      .where(and(...conditions))
      .orderBy(asc(branches.name))
      .limit(pagination.limit ?? 50)
      .offset(pagination.offset ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(branches).where(and(...conditions)),
    ]);

    if (branchList.length === 0) return { items: [], total: countRows[0]?.count ?? 0 };

    const branchIds = branchList.map((b) => b.id);

    // Active attendants per branch
    const attendantCounts = await db
      .select({
        branchId: attendants.branchId,
        count: sql<number>`count(*)::int`,
      })
      .from(attendants)
      .where(
        and(
          inArray(attendants.branchId, branchIds),
          eq(attendants.status, "active"),
          isNull(attendants.deletedAt)
        )
      )
      .groupBy(attendants.branchId);

    const attendantCountMap = new Map(attendantCounts.map((a) => [a.branchId, a.count]));

    // Machines per branch
    const machineCounts = await db
      .select({
        branchId: branchMachines.branchId,
        count: sql<number>`count(*)::int`,
      })
      .from(branchMachines)
      .where(
        and(
          inArray(branchMachines.branchId, branchIds),
          isNull(branchMachines.deletedAt)
        )
      )
      .groupBy(branchMachines.branchId);

    const machineCountMap = new Map(machineCounts.map((m) => [m.branchId, m.count]));

    // Today's orders per branch
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayOrderCounts = await db
      .select({
        branchId: orders.branchId,
        count: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          inArray(orders.branchId, branchIds),
          sql`${orders.createdAt} >= ${todayStart}`,
          isNull(orders.deletedAt)
        )
      )
      .groupBy(orders.branchId);

    const todayOrderCountMap = new Map(todayOrderCounts.map((o) => [o.branchId, o.count]));

    const items = branchList.map((b) =>
      toBranchDto(b, {
        activeAttendantsCount: attendantCountMap.get(b.id) ?? 0,
        todayOrdersCount: todayOrderCountMap.get(b.id) ?? 0,
        machinesCount: machineCountMap.get(b.id) ?? 0,
      })
    );
    return { items, total: countRows[0]?.count ?? 0 };
  },

  async getBranchById(id: string) {
    const [branch] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.id, id), isNull(branches.deletedAt)))
      .limit(1);

    if (!branch) {
      throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");
    }

    const [attendantCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(attendants)
      .where(and(eq(attendants.branchId, id), eq(attendants.status, "active"), isNull(attendants.deletedAt)));

    const [machineCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(branchMachines)
      .where(and(eq(branchMachines.branchId, id), isNull(branchMachines.deletedAt)));

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayOrderCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.branchId, id), sql`${orders.createdAt} >= ${todayStart}`, isNull(orders.deletedAt)));

    return toBranchDto(branch, {
      activeAttendantsCount: attendantCount?.count ?? 0,
      todayOrdersCount: todayOrderCount?.count ?? 0,
      machinesCount: machineCount?.count ?? 0,
    });
  },

  async getBranchByCode(code: string) {
    const normalizedCode = code.toUpperCase().trim().replace(/\s+/g, "");
    const [branch] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.code, normalizedCode), isNull(branches.deletedAt)))
      .limit(1);

    if (!branch) {
      throw new NotFoundError(`Branch with code ${normalizedCode} not found`, "BRANCH_NOT_FOUND");
    }

    return toBranchDto(branch);
  },

  async createBranch(
    actor: AuthenticatedUser,
    input: {
      name: string;
      code: string;
      terminalId?: string;
      phoneNumber: string;
      email?: string;
      address: string;
      city: string;
      pricingPerKg?: number;
      pricingPerKgPesewas?: number;
      deliveryFee?: number;
      deliveryFeePesewas?: number;
      stationPin: string;
      weeklyOrderTarget?: number;
      momoNumber?: string;
    },
    meta?: RequestMeta
  ) {
    const code = input.code.toUpperCase().trim().replace(/\s+/g, "");
    if (code.length < 2 || code.length > 10) {
      throw new BadRequestError("Branch code must be between 2 and 10 characters");
    }

    const terminalId = input.terminalId ? input.terminalId.trim() : null;
    if (terminalId && !/^\d{3}$/.test(terminalId)) {
      throw new BadRequestError("Terminal ID must be exactly 3 digits");
    }

    // Check code uniqueness
    const [existingCode] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.code, code), isNull(branches.deletedAt)))
      .limit(1);

    if (existingCode) {
      throw new ConflictError(`Branch code "${code}" already exists`, "BRANCH_CODE_EXISTS");
    }

    if (terminalId) {
      const [existingTerminal] = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.terminalId, terminalId), isNull(branches.deletedAt)))
        .limit(1);

      if (existingTerminal) {
        throw new ConflictError(`Terminal ID "${terminalId}" already exists`, "BRANCH_TERMINAL_EXISTS");
      }
    }

    const pin = input.stationPin.trim();
    if (pin.length < 4) {
      throw new BadRequestError("Station PIN must be at least 4 characters");
    }

    const stationPinHash = await hashSecret(pin);

    const pricingPerKgPesewas = BigInt(
      input.pricingPerKgPesewas ?? (input.pricingPerKg ? Math.round(input.pricingPerKg * 100) : 0)
    );
    const deliveryFeePesewas = BigInt(
      input.deliveryFeePesewas ?? (input.deliveryFee ? Math.round(input.deliveryFee * 100) : 0)
    );

    return await db.transaction(async (tx) => {
      const [newBranch] = await tx
        .insert(branches)
        .values({
          name: input.name.trim(),
          code,
          terminalId,
          phoneNumber: input.phoneNumber.trim(),
          email: input.email?.trim().toLowerCase() || null,
          address: input.address.trim(),
          city: input.city.trim(),
          pricingPerKgPesewas,
          deliveryFeePesewas,
          stationPinHash,
          requireStationLogin: true,
          weeklyOrderTarget: input.weeklyOrderTarget ?? 0,
          momoNumber: input.momoNumber || null,
          isActive: true,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "branch.created",
        "branch",
        newBranch.id,
        {
          name: newBranch.name,
          code: newBranch.code,
          terminalId: newBranch.terminalId,
          city: newBranch.city,
        },
        meta
      );

      return toBranchDto(newBranch);
    });
  },

  async updateBranch(
    actor: AuthenticatedUser,
    id: string,
    input: {
      name?: string;
      code?: string;
      terminalId?: string;
      phoneNumber?: string;
      email?: string;
      address?: string;
      city?: string;
      pricingPerKg?: number;
      pricingPerKgPesewas?: number;
      deliveryFee?: number;
      deliveryFeePesewas?: number;
      stationPin?: string;
      weeklyOrderTarget?: number;
      momoNumber?: string;
      isActive?: boolean;
    },
    meta?: RequestMeta
  ) {
    const [existing] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.id, id), isNull(branches.deletedAt)))
      .limit(1);

    if (!existing) {
      throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");
    }

    const updates: Partial<typeof branches.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.phoneNumber !== undefined) updates.phoneNumber = input.phoneNumber.trim();
    if (input.email !== undefined) updates.email = input.email ? input.email.trim().toLowerCase() : null;
    if (input.address !== undefined) updates.address = input.address.trim();
    if (input.city !== undefined) updates.city = input.city.trim();
    if (input.weeklyOrderTarget !== undefined) updates.weeklyOrderTarget = input.weeklyOrderTarget;
    if (input.momoNumber !== undefined) updates.momoNumber = input.momoNumber;
    if (input.isActive !== undefined) updates.isActive = input.isActive;

    if (input.pricingPerKgPesewas !== undefined) {
      updates.pricingPerKgPesewas = BigInt(input.pricingPerKgPesewas);
    } else if (input.pricingPerKg !== undefined) {
      updates.pricingPerKgPesewas = BigInt(Math.round(input.pricingPerKg * 100));
    }

    if (input.deliveryFeePesewas !== undefined) {
      updates.deliveryFeePesewas = BigInt(input.deliveryFeePesewas);
    } else if (input.deliveryFee !== undefined) {
      updates.deliveryFeePesewas = BigInt(Math.round(input.deliveryFee * 100));
    }

    if (input.code !== undefined) {
      const code = input.code.toUpperCase().trim().replace(/\s+/g, "");
      if (code.length < 2 || code.length > 10) {
        throw new BadRequestError("Branch code must be between 2 and 10 characters");
      }
      const [conflict] = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.code, code), isNull(branches.deletedAt)))
        .limit(1);

      if (conflict && conflict.id !== id) {
        throw new ConflictError(`Branch code "${code}" already exists`, "BRANCH_CODE_EXISTS");
      }
      updates.code = code;
    }

    if (input.terminalId !== undefined) {
      const terminalId = input.terminalId ? input.terminalId.trim() : null;
      if (terminalId && !/^\d{3}$/.test(terminalId)) {
        throw new BadRequestError("Terminal ID must be exactly 3 digits");
      }
      if (terminalId) {
        const [conflict] = await db
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.terminalId, terminalId), isNull(branches.deletedAt)))
          .limit(1);

        if (conflict && conflict.id !== id) {
          throw new ConflictError(`Terminal ID "${terminalId}" already exists`, "BRANCH_TERMINAL_EXISTS");
        }
      }
      updates.terminalId = terminalId;
    }

    if (input.stationPin !== undefined) {
      if (input.stationPin.trim().length < 4) {
        throw new BadRequestError("Station PIN must be at least 4 characters");
      }
      updates.stationPinHash = await hashSecret(input.stationPin.trim());
    }

    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(branches)
        .set(updates)
        .where(eq(branches.id, id))
        .returning();

      await writeAudit(
        tx,
        actor,
        "branch.updated",
        "branch",
        id,
        {
          previous: { name: existing.name, code: existing.code, isActive: existing.isActive },
          updated: { name: updated.name, code: updated.code, isActive: updated.isActive },
        },
        meta
      );

      return toBranchDto(updated);
    });
  },

  async toggleBranchStatus(actor: AuthenticatedUser, id: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.id, id), isNull(branches.deletedAt)))
      .limit(1);

    if (!existing) {
      throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");
    }

    const newStatus = !existing.isActive;

    return await db.transaction(async (tx) => {
      await tx
        .update(branches)
        .set({ isActive: newStatus, updatedAt: new Date() })
        .where(eq(branches.id, id));

      await writeAudit(
        tx,
        actor,
        newStatus ? "branch.enabled" : "branch.disabled",
        "branch",
        id,
        { previousActive: existing.isActive, newActive: newStatus },
        meta
      );

      return { branchId: id, isActive: newStatus };
    });
  },

  async deleteBranch(actor: AuthenticatedUser, id: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.id, id), isNull(branches.deletedAt)))
      .limit(1);

    if (!existing) {
      throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");
    }

    // Check for active orders
    const [activeOrder] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.branchId, id),
          isNull(orders.deletedAt),
          notInArray(orders.status, ["completed", "cancelled"])
        )
      )
      .limit(1);

    if (activeOrder) {
      throw new BadRequestError(
        "Cannot delete branch with active orders. Please complete or cancel all orders first."
      );
    }

    return await db.transaction(async (tx) => {
      await tx
        .update(branches)
        .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
        .where(eq(branches.id, id));

      await writeAudit(
        tx,
        actor,
        "branch.deleted",
        "branch",
        id,
        { code: existing.code, name: existing.name },
        meta
      );

      return { branchId: id, success: true };
    });
  },

  async updateBranchDeliveryFees(
    actor: AuthenticatedUser,
    id: string,
    deliveryFees: {
      dropoff_self: number;
      dropoff_delivery: number;
      pickup_self: number;
      full_service: number;
    },
    meta?: RequestMeta
  ) {
    const [existing] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.id, id), isNull(branches.deletedAt)))
      .limit(1);

    if (!existing) {
      throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");
    }

    return await db.transaction(async (tx) => {
      await tx
        .update(branches)
        .set({ deliveryFees, updatedAt: new Date() })
        .where(eq(branches.id, id));

      await writeAudit(
        tx,
        actor,
        "branch.delivery_fees_updated",
        "branch",
        id,
        { previous: existing.deliveryFees, new: deliveryFees },
        meta
      );

      return { branchId: id, deliveryFees };
    });
  },

  async getBranchAttendanceSummary() {
    const activeAttendances = await db
      .select({
        attendanceId: attendanceLogs.id,
        clockInAt: attendanceLogs.clockInAt,
        branchId: attendanceLogs.branchId,
        attendantId: attendanceLogs.attendantId,
        attendantName: attendants.name,
        attendantEmail: attendants.email,
      })
      .from(attendanceLogs)
      .innerJoin(attendants, eq(attendanceLogs.attendantId, attendants.id))
      .where(isNull(attendanceLogs.clockOutAt));

    const branchList = await db
      .select({
        id: branches.id,
        name: branches.name,
        code: branches.code,
        terminalId: branches.terminalId,
      })
      .from(branches)
      .where(isNull(branches.deletedAt));

    const summaries = branchList.map((branch) => {
      const forThisBranch = activeAttendances.filter((a) => a.branchId === branch.id);
      return {
        branch: {
          _id: branch.id,
          id: branch.id,
          name: branch.name,
          code: branch.code,
          terminalId: branch.terminalId,
        },
        activeCount: forThisBranch.length,
        attendances: forThisBranch.map((a) => ({
          attendanceId: a.attendanceId,
          clockInAt: a.clockInAt.toISOString(),
          attendant: {
            _id: a.attendantId,
            id: a.attendantId,
            name: a.attendantName,
            email: a.attendantEmail,
          },
        })),
      };
    });

    return summaries.filter((s) => s.activeCount > 0);
  },

  // --- Branch Machines ---
  async listMachinesByBranch(
    branchId: string,
    onlyActive?: boolean,
    pagination: { limit?: number; offset?: number } = {}
  ) {
    const conditions = [eq(branchMachines.branchId, branchId), isNull(branchMachines.deletedAt)];
    if (onlyActive) {
      conditions.push(eq(branchMachines.isActive, true));
    }

    const [rows, countRows] = await Promise.all([
      db
      .select()
      .from(branchMachines)
      .where(and(...conditions))
      .orderBy(asc(branchMachines.name))
      .limit(pagination.limit ?? 50)
      .offset(pagination.offset ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(branchMachines).where(and(...conditions)),
    ]);

    return { items: rows.map((m) => ({
      id: m.id,
      _id: m.id,
      branchId: m.branchId,
      name: m.name,
      displayName: m.displayName,
      serialNumber: m.serialNumber,
      otherDetails: m.otherDetails,
      washPrice: Number(m.washPricePesewas) / 100,
      washPricePesewas: m.washPricePesewas.toString(),
      isActive: m.isActive,
      createdAt: m.createdAt.toISOString(),
    })), total: countRows[0]?.count ?? 0 };
  },

  async createMachine(
    actor: AuthenticatedUser,
    input: {
      branchId: string;
      name: string;
      displayName: string;
      serialNumber?: string;
      otherDetails?: string;
      washPrice?: number;
      washPricePesewas?: number;
    },
    meta?: RequestMeta
  ) {
    const [branch] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.id, input.branchId), isNull(branches.deletedAt)))
      .limit(1);

    if (!branch) throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");

    const washPricePesewas = BigInt(
      input.washPricePesewas ?? (input.washPrice ? Math.round(input.washPrice * 100) : 0)
    );

    return await db.transaction(async (tx) => {
      const [machine] = await tx
        .insert(branchMachines)
        .values({
          branchId: input.branchId,
          name: input.name.trim(),
          displayName: input.displayName.trim(),
          serialNumber: input.serialNumber?.trim() || null,
          otherDetails: input.otherDetails?.trim() || null,
          washPricePesewas,
          isActive: true,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "branch_machine.created",
        "branch_machine",
        machine.id,
        { branchId: machine.branchId, name: machine.name },
        meta
      );

      return {
        id: machine.id,
        _id: machine.id,
        branchId: machine.branchId,
        name: machine.name,
        displayName: machine.displayName,
        serialNumber: machine.serialNumber,
        otherDetails: machine.otherDetails,
        washPrice: Number(machine.washPricePesewas) / 100,
        washPricePesewas: machine.washPricePesewas.toString(),
        isActive: machine.isActive,
        createdAt: machine.createdAt.toISOString(),
      };
    });
  },

  async updateMachine(
    actor: AuthenticatedUser,
    machineId: string,
    input: {
      name?: string;
      displayName?: string;
      serialNumber?: string;
      otherDetails?: string;
      washPrice?: number;
      washPricePesewas?: number;
      isActive?: boolean;
    },
    meta?: RequestMeta
  ) {
    const [existing] = await db
      .select()
      .from(branchMachines)
      .where(and(eq(branchMachines.id, machineId), isNull(branchMachines.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Machine not found", "MACHINE_NOT_FOUND");

    const updates: Partial<typeof branchMachines.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.displayName !== undefined) updates.displayName = input.displayName.trim();
    if (input.serialNumber !== undefined) updates.serialNumber = input.serialNumber.trim();
    if (input.otherDetails !== undefined) updates.otherDetails = input.otherDetails.trim();
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    if (input.washPricePesewas !== undefined) {
      updates.washPricePesewas = BigInt(input.washPricePesewas);
    } else if (input.washPrice !== undefined) {
      updates.washPricePesewas = BigInt(Math.round(input.washPrice * 100));
    }

    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(branchMachines)
        .set(updates)
        .where(eq(branchMachines.id, machineId))
        .returning();

      await writeAudit(
        tx,
        actor,
        "branch_machine.updated",
        "branch_machine",
        machineId,
        { previous: existing, updated },
        meta
      );

      return {
        id: updated.id,
        _id: updated.id,
        branchId: updated.branchId,
        name: updated.name,
        displayName: updated.displayName,
        serialNumber: updated.serialNumber,
        otherDetails: updated.otherDetails,
        washPrice: Number(updated.washPricePesewas) / 100,
        washPricePesewas: updated.washPricePesewas.toString(),
        isActive: updated.isActive,
        createdAt: updated.createdAt.toISOString(),
      };
    });
  },

  async deleteMachine(actor: AuthenticatedUser, machineId: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(branchMachines)
      .where(and(eq(branchMachines.id, machineId), isNull(branchMachines.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Machine not found", "MACHINE_NOT_FOUND");

    return await db.transaction(async (tx) => {
      await tx
        .update(branchMachines)
        .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
        .where(eq(branchMachines.id, machineId));

      await writeAudit(
        tx,
        actor,
        "branch_machine.deleted",
        "branch_machine",
        machineId,
        { name: existing.name },
        meta
      );

      return { success: true, id: machineId };
    });
  },

  // --- Catalog Services ---
  async listCatalogServices(pagination: { limit?: number; offset?: number } = {}) {
    const condition = isNull(services.deletedAt);
    const [rows, countRows] = await Promise.all([
      db
      .select()
      .from(services)
      .where(condition)
      .orderBy(asc(services.name))
      .limit(pagination.limit ?? 50)
      .offset(pagination.offset ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(services).where(condition),
    ]);

    return { items: rows.map((s) => ({
      id: s.id,
      _id: s.id,
      name: s.name,
      code: s.code,
      description: s.description,
      imageUrl: s.imageUrl,
      basePrice: Number(s.basePricePesewas) / 100,
      basePricePesewas: s.basePricePesewas.toString(),
      pricingType: s.pricingType,
      isActive: s.isActive,
      createdAt: s.createdAt.toISOString(),
    })), total: countRows[0]?.count ?? 0 };
  },

  async createCatalogService(
    actor: AuthenticatedUser,
    input: {
      name: string;
      code: string;
      description?: string;
      imageUrl?: string;
      basePrice?: number;
      basePricePesewas?: number;
      pricingType?: "per_kg" | "per_load";
    },
    meta?: RequestMeta
  ) {
    const code = input.code.trim();
    const [existing] = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.code, code), isNull(services.deletedAt)))
      .limit(1);

    if (existing) throw new ConflictError("Service with this code already exists", "SERVICE_CODE_EXISTS");

    const basePricePesewas = BigInt(
      input.basePricePesewas ?? (input.basePrice ? Math.round(input.basePrice * 100) : 0)
    );

    return await db.transaction(async (tx) => {
      const [service] = await tx
        .insert(services)
        .values({
          name: input.name.trim(),
          code,
          description: input.description?.trim() || null,
          imageUrl: input.imageUrl?.trim() || null,
          basePricePesewas,
          pricingType: input.pricingType || "per_load",
          isActive: true,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "service.created",
        "service",
        service.id,
        { name: service.name, code: service.code },
        meta
      );

      return {
        id: service.id,
        _id: service.id,
        name: service.name,
        code: service.code,
        description: service.description,
        imageUrl: service.imageUrl,
        basePrice: Number(service.basePricePesewas) / 100,
        basePricePesewas: service.basePricePesewas.toString(),
        pricingType: service.pricingType,
        isActive: service.isActive,
        createdAt: service.createdAt.toISOString(),
      };
    });
  },

  async updateCatalogService(
    actor: AuthenticatedUser,
    serviceId: string,
    input: {
      name?: string;
      description?: string;
      imageUrl?: string;
      basePrice?: number;
      basePricePesewas?: number;
      pricingType?: "per_kg" | "per_load";
      isActive?: boolean;
    },
    meta?: RequestMeta
  ) {
    const [existing] = await db
      .select()
      .from(services)
      .where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Service not found", "SERVICE_NOT_FOUND");

    const updates: Partial<typeof services.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.description !== undefined) updates.description = input.description.trim();
    if (input.imageUrl !== undefined) updates.imageUrl = input.imageUrl.trim();
    if (input.pricingType !== undefined) updates.pricingType = input.pricingType;
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    if (input.basePricePesewas !== undefined) {
      updates.basePricePesewas = BigInt(input.basePricePesewas);
    } else if (input.basePrice !== undefined) {
      updates.basePricePesewas = BigInt(Math.round(input.basePrice * 100));
    }

    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(services)
        .set(updates)
        .where(eq(services.id, serviceId))
        .returning();

      await writeAudit(
        tx,
        actor,
        "service.updated",
        "service",
        serviceId,
        { previous: existing, updated },
        meta
      );

      return {
        id: updated.id,
        _id: updated.id,
        name: updated.name,
        code: updated.code,
        description: updated.description,
        imageUrl: updated.imageUrl,
        basePrice: Number(updated.basePricePesewas) / 100,
        basePricePesewas: updated.basePricePesewas.toString(),
        pricingType: updated.pricingType,
        isActive: updated.isActive,
        createdAt: updated.createdAt.toISOString(),
      };
    });
  },

  async deleteCatalogService(actor: AuthenticatedUser, serviceId: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(services)
      .where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Service not found", "SERVICE_NOT_FOUND");

    return await db.transaction(async (tx) => {
      await tx
        .update(services)
        .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
        .where(eq(services.id, serviceId));

      await writeAudit(
        tx,
        actor,
        "service.deleted",
        "service",
        serviceId,
        { name: existing.name },
        meta
      );

      return { success: true, id: serviceId };
    });
  },

  // --- Branch Services ---
  async listBranchServices(branchId: string, pagination: { limit?: number; offset?: number } = {}) {
    const condition = and(eq(branchServices.branchId, branchId), isNull(branchServices.deletedAt));
    const [rows, countRows] = await Promise.all([
      db
      .select()
      .from(branchServices)
      .where(condition)
      .orderBy(asc(branchServices.name))
      .limit(pagination.limit ?? 50)
      .offset(pagination.offset ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(branchServices).where(condition),
    ]);

    return { items: rows.map((s) => ({
      id: s.id,
      _id: s.id,
      branchId: s.branchId,
      name: s.name,
      code: s.code,
      price: Number(s.pricePesewas) / 100,
      pricePesewas: s.pricePesewas.toString(),
      extraWashPrice: s.extraWashPricePesewas ? Number(s.extraWashPricePesewas) / 100 : null,
      extraDryPrice: s.extraDryPricePesewas ? Number(s.extraDryPricePesewas) / 100 : null,
      extraWashPricePesewas: s.extraWashPricePesewas ? s.extraWashPricePesewas.toString() : null,
      extraDryPricePesewas: s.extraDryPricePesewas ? s.extraDryPricePesewas.toString() : null,
      description: s.description,
      imageUrl: s.imageUrl,
      isActive: s.isActive,
      showOnCustomerSide: s.showOnCustomerSide,
      createdAt: s.createdAt.toISOString(),
    })), total: countRows[0]?.count ?? 0 };
  },

  async createBranchService(
    actor: AuthenticatedUser,
    input: {
      branchId: string;
      name: string;
      code: string;
      price?: number;
      pricePesewas?: number;
      extraWashPrice?: number;
      extraDryPrice?: number;
      extraWashPricePesewas?: number;
      extraDryPricePesewas?: number;
      description?: string;
      imageUrl?: string;
      showOnCustomerSide?: boolean;
    },
    meta?: RequestMeta
  ) {
    const [branch] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.id, input.branchId), isNull(branches.deletedAt)))
      .limit(1);

    if (!branch) throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");

    const pricePesewas = BigInt(
      input.pricePesewas ?? (input.price ? Math.round(input.price * 100) : 0)
    );
    const extraWashPricePesewas = input.extraWashPricePesewas
      ? BigInt(input.extraWashPricePesewas)
      : input.extraWashPrice
      ? BigInt(Math.round(input.extraWashPrice * 100))
      : null;
    const extraDryPricePesewas = input.extraDryPricePesewas
      ? BigInt(input.extraDryPricePesewas)
      : input.extraDryPrice
      ? BigInt(Math.round(input.extraDryPrice * 100))
      : null;

    return await db.transaction(async (tx) => {
      const [service] = await tx
        .insert(branchServices)
        .values({
          branchId: input.branchId,
          name: input.name.trim(),
          code: input.code.trim(),
          pricePesewas,
          extraWashPricePesewas,
          extraDryPricePesewas,
          description: input.description?.trim() || null,
          imageUrl: input.imageUrl?.trim() || null,
          showOnCustomerSide: input.showOnCustomerSide ?? false,
          isActive: true,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "branch_service.created",
        "branch_service",
        service.id,
        { branchId: service.branchId, name: service.name, code: service.code },
        meta
      );

      return {
        id: service.id,
        _id: service.id,
        branchId: service.branchId,
        name: service.name,
        code: service.code,
        price: Number(service.pricePesewas) / 100,
        pricePesewas: service.pricePesewas.toString(),
        extraWashPrice: service.extraWashPricePesewas ? Number(service.extraWashPricePesewas) / 100 : null,
        extraDryPrice: service.extraDryPricePesewas ? Number(service.extraDryPricePesewas) / 100 : null,
        extraWashPricePesewas: service.extraWashPricePesewas ? service.extraWashPricePesewas.toString() : null,
        extraDryPricePesewas: service.extraDryPricePesewas ? service.extraDryPricePesewas.toString() : null,
        description: service.description,
        imageUrl: service.imageUrl,
        isActive: service.isActive,
        showOnCustomerSide: service.showOnCustomerSide,
        createdAt: service.createdAt.toISOString(),
      };
    });
  },

  async updateBranchService(
    actor: AuthenticatedUser,
    serviceId: string,
    input: {
      name?: string;
      price?: number;
      pricePesewas?: number;
      extraWashPrice?: number;
      extraDryPrice?: number;
      extraWashPricePesewas?: number;
      extraDryPricePesewas?: number;
      description?: string;
      imageUrl?: string;
      isActive?: boolean;
      showOnCustomerSide?: boolean;
    },
    meta?: RequestMeta
  ) {
    const [existing] = await db
      .select()
      .from(branchServices)
      .where(and(eq(branchServices.id, serviceId), isNull(branchServices.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Branch service not found", "BRANCH_SERVICE_NOT_FOUND");

    const updates: Partial<typeof branchServices.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.description !== undefined) updates.description = input.description.trim();
    if (input.imageUrl !== undefined) updates.imageUrl = input.imageUrl.trim();
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    if (input.showOnCustomerSide !== undefined) updates.showOnCustomerSide = input.showOnCustomerSide;

    if (input.pricePesewas !== undefined) {
      updates.pricePesewas = BigInt(input.pricePesewas);
    } else if (input.price !== undefined) {
      updates.pricePesewas = BigInt(Math.round(input.price * 100));
    }

    if (input.extraWashPricePesewas !== undefined) {
      updates.extraWashPricePesewas = BigInt(input.extraWashPricePesewas);
    } else if (input.extraWashPrice !== undefined) {
      updates.extraWashPricePesewas = BigInt(Math.round(input.extraWashPrice * 100));
    }

    if (input.extraDryPricePesewas !== undefined) {
      updates.extraDryPricePesewas = BigInt(input.extraDryPricePesewas);
    } else if (input.extraDryPrice !== undefined) {
      updates.extraDryPricePesewas = BigInt(Math.round(input.extraDryPrice * 100));
    }

    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(branchServices)
        .set(updates)
        .where(eq(branchServices.id, serviceId))
        .returning();

      await writeAudit(
        tx,
        actor,
        "branch_service.updated",
        "branch_service",
        serviceId,
        { previous: existing, updated },
        meta
      );

      return {
        id: updated.id,
        _id: updated.id,
        branchId: updated.branchId,
        name: updated.name,
        code: updated.code,
        price: Number(updated.pricePesewas) / 100,
        pricePesewas: updated.pricePesewas.toString(),
        extraWashPrice: updated.extraWashPricePesewas ? Number(updated.extraWashPricePesewas) / 100 : null,
        extraDryPrice: updated.extraDryPricePesewas ? Number(updated.extraDryPricePesewas) / 100 : null,
        extraWashPricePesewas: updated.extraWashPricePesewas ? updated.extraWashPricePesewas.toString() : null,
        extraDryPricePesewas: updated.extraDryPricePesewas ? updated.extraDryPricePesewas.toString() : null,
        description: updated.description,
        imageUrl: updated.imageUrl,
        isActive: updated.isActive,
        showOnCustomerSide: updated.showOnCustomerSide,
        createdAt: updated.createdAt.toISOString(),
      };
    });
  },

  async deleteBranchService(actor: AuthenticatedUser, serviceId: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(branchServices)
      .where(and(eq(branchServices.id, serviceId), isNull(branchServices.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Branch service not found", "BRANCH_SERVICE_NOT_FOUND");

    return await db.transaction(async (tx) => {
      await tx
        .update(branchServices)
        .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
        .where(eq(branchServices.id, serviceId));

      await writeAudit(
        tx,
        actor,
        "branch_service.deleted",
        "branch_service",
        serviceId,
        { name: existing.name },
        meta
      );

      return { success: true, id: serviceId };
    });
  },
};
