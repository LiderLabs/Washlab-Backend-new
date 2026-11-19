import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { orders, orderStatusEvents, orderStatusEnum } from "../../platform/db/schema/orders.js";
import { customers } from "../../platform/db/schema/customers.js";
import { branches } from "../../platform/db/schema/branches.js";
import { loyaltyLedger } from "../../platform/db/schema/loyalty.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
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

export const adminOrdersService = {
  // --- Admin Orders ---
  async listOrders(query: {
    branchId?: string;
    status?: string;
    startDate?: number;
    endDate?: number;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions = [isNull(orders.deletedAt)];

    if (query.branchId) {
      conditions.push(eq(orders.branchId, query.branchId));
    }

    if (query.status) {
      conditions.push(eq(orders.status, query.status as any));
    }

    if (query.startDate) {
      conditions.push(gte(orders.createdAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(orders.createdAt, new Date(query.endDate)));
    }

    if (query.search) {
      const s = `%${query.search.trim()}%`;
      conditions.push(or(ilike(orders.orderNumber, s), ilike(customers.phoneNumber, s), ilike(customers.name, s))!);
    }

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerId: orders.customerId,
        customerName: customers.name,
        branchId: orders.branchId,
        branchName: branches.name,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        paymentMethod: orders.paymentMethod,
        finalPricePesewas: orders.finalPricePesewas,
        weightKg: orders.weightKg,
        serviceType: orders.serviceType,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .where(and(...conditions))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => {
      const finalPrice = Number(r.finalPricePesewas) / 100;
      return {
        id: r.id,
        _id: r.id,
        orderNumber: r.orderNumber,
        customerId: r.customerId,
        customerName: r.customerName ?? null,
        branchId: r.branchId,
        branchName: r.branchName ?? null,
        status: r.status,
        paymentStatus: r.paymentStatus,
        paymentMethod: r.paymentMethod,
        totalAmount: finalPrice,
        totalAmountPesewas: r.finalPricePesewas.toString(),
        finalPrice,
        weightKg: r.weightKg ? Number(r.weightKg) : null,
        serviceType: r.serviceType,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  },

  async getOrderDetails(orderId: string) {
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);

    if (!order) {
      throw new NotFoundError("Order not found", "ORDER_NOT_FOUND");
    }

    const [customer] = order.customerId
      ? await db
          .select({
            id: customers.id,
            name: customers.name,
            phoneNumber: customers.phoneNumber,
            email: customers.email,
          })
          .from(customers)
          .where(eq(customers.id, order.customerId))
          .limit(1)
      : [null];

    const [branch] = await db
      .select({
        id: branches.id,
        name: branches.name,
        code: branches.code,
        address: branches.address,
        city: branches.city,
      })
      .from(branches)
      .where(eq(branches.id, order.branchId))
      .limit(1);

    const historyEvents = await db
      .select()
      .from(orderStatusEvents)
      .where(eq(orderStatusEvents.orderId, orderId))
      .orderBy(asc(orderStatusEvents.createdAt));

    const basePrice = Number(order.basePricePesewas) / 100;
    const servicePrice = Number(order.servicePricePesewas) / 100;
    const deliveryFee = Number(order.deliveryFeePesewas) / 100;
    const discount = Number(order.discountPesewas) / 100;
    const finalPrice = Number(order.finalPricePesewas) / 100;

    return {
      id: order.id,
      _id: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      customer: customer
        ? {
            id: customer.id,
            _id: customer.id,
            name: customer.name,
            phoneNumber: customer.phoneNumber,
            email: customer.email,
          }
        : null,
      branchId: order.branchId,
      branch: branch
        ? {
            id: branch.id,
            _id: branch.id,
            name: branch.name,
            code: branch.code,
            address: branch.address,
            city: branch.city,
          }
        : null,
      orderType: order.orderType,
      serviceType: order.serviceType,
      bagNumber: order.bagNumber,
      itemCount: order.itemCount,
      estimatedLoads: order.estimatedLoads,
      extraWashLoads: order.extraWashLoads,
      extraDryLoads: order.extraDryLoads,
      whitesSeparate: order.whitesSeparate,
      notes: order.notes,
      isDelivery: order.isDelivery,
      deliveryAddress: order.deliveryAddress,
      deliveryPhone: order.deliveryPhone,
      status: order.status,
      weightKg: order.weightKg ? Number(order.weightKg) : null,
      basePrice,
      servicePrice,
      deliveryFee,
      discount,
      finalPrice,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      statusHistory: historyEvents.map((e) => ({
        status: e.toStatus,
        changedAt: e.createdAt.toISOString(),
        changedByRole: e.changedByRole,
        notes: e.notes,
      })),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  },

  async updateOrderStatus(
    actor: AuthenticatedUser,
    orderId: string,
    newStatus: string,
    notes?: string,
    meta?: RequestMeta
  ) {
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);

    if (!order) throw new NotFoundError("Order not found", "ORDER_NOT_FOUND");

    const oldStatus = order.status;
    const now = new Date();

    return await db.transaction(async (tx) => {
      await tx
        .update(orders)
        .set({
          status: newStatus as any,
          completedAt: newStatus === "completed" ? now : order.completedAt,
          updatedAt: now,
        })
        .where(eq(orders.id, orderId));

      await tx.insert(orderStatusEvents).values({
        orderId,
        fromStatus: oldStatus,
        toStatus: newStatus as any,
        changedByUserId: actor.id,
        changedByRole: actor.role as any,
        notes: notes || null,
        createdAt: now,
      });

      // Award loyalty points if completed
      if (newStatus === "completed" && oldStatus !== "completed" && order.customerId) {
        try {
          const [cust] = await tx
            .select({ loyaltyPoints: customers.loyaltyPoints })
            .from(customers)
            .where(eq(customers.id, order.customerId))
            .limit(1);

          const newBalance = (cust?.loyaltyPoints ?? 0) + 1;

          await tx
            .update(customers)
            .set({
              loyaltyPoints: newBalance,
              updatedAt: now,
            })
            .where(eq(customers.id, order.customerId));

          await tx.insert(loyaltyLedger).values({
            customerId: order.customerId,
            orderId,
            pointsDelta: 1,
            balanceAfter: newBalance,
            reason: "order_completed",
            createdAt: now,
          });
        } catch (err) {
          console.error("Failed to credit loyalty points:", err);
        }
      }

      await writeAudit(
        tx,
        actor,
        "order.status.updated",
        "order",
        orderId,
        { previousStatus: oldStatus, newStatus, notes },
        meta
      );

      return { success: true, orderId, status: newStatus };
    });
  },

  async deleteOrder(actor: AuthenticatedUser, orderId: string, meta?: RequestMeta) {
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);

    if (!order) throw new NotFoundError("Order not found", "ORDER_NOT_FOUND");

    return await db.transaction(async (tx) => {
      await tx
        .update(orders)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(orders.id, orderId));

      await writeAudit(
        tx,
        actor,
        "order.deleted",
        "order",
        orderId,
        { orderNumber: order.orderNumber, status: order.status },
        meta
      );

      return { success: true, orderId };
    });
  },

  // --- Admin Customers ---
  async listCustomers(query: {
    search?: string;
    status?: "active" | "blocked" | "suspended" | "restricted";
    isRegistered?: boolean;
    branchId?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions = [isNull(customers.deletedAt)];

    if (query.status) {
      conditions.push(eq(customers.status, query.status));
    }

    if (query.isRegistered !== undefined) {
      conditions.push(eq(customers.isRegistered, query.isRegistered));
    }

    if (query.branchId) {
      conditions.push(eq(customers.branchId, query.branchId));
    }

    if (query.search) {
      const s = `%${query.search.trim()}%`;
      conditions.push(or(ilike(customers.name, s), ilike(customers.phoneNumber, s), ilike(customers.email, s))!);
    }

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const customerList = await db
      .select({
        id: customers.id,
        name: customers.name,
        phoneNumber: customers.phoneNumber,
        email: customers.email,
        branchId: customers.branchId,
        branchName: branches.name,
        status: customers.status,
        statusNote: customers.statusNote,
        isRegistered: customers.isRegistered,
        isVerified: customers.isVerified,
        loyaltyPoints: customers.loyaltyPoints,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .leftJoin(branches, eq(customers.branchId, branches.id))
      .where(and(...conditions))
      .orderBy(desc(customers.createdAt))
      .limit(limit)
      .offset(offset);

    if (customerList.length === 0) return [];

    const customerIds = customerList.map((c) => c.id);

    // Fetch order aggregation for these customers
    const customerOrders = await db
      .select({
        customerId: orders.customerId,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        finalPricePesewas: orders.finalPricePesewas,
        createdAt: orders.createdAt,
        orderNumber: orders.orderNumber,
        branchName: branches.name,
      })
      .from(orders)
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .where(and(inArray(orders.customerId, customerIds), isNull(orders.deletedAt)))
      .orderBy(desc(orders.createdAt));

    // Group orders by customerId
    const statsMap = new Map<
      string,
      {
        orderCount: number;
        completedCount: number;
        totalSpent: number;
        lastOrderDate: string | null;
        lastOrderNumber: string | null;
        branchesSeen: Set<string>;
      }
    >();

    for (const o of customerOrders) {
      if (!o.customerId) continue;
      const entry = statsMap.get(o.customerId) ?? {
        orderCount: 0,
        completedCount: 0,
        totalSpent: 0,
        lastOrderDate: null,
        lastOrderNumber: null,
        branchesSeen: new Set<string>(),
      };

      entry.orderCount += 1;
      if (o.status === "completed") {
        entry.completedCount += 1;
      }
      if (o.paymentStatus === "paid") {
        entry.totalSpent += Number(o.finalPricePesewas) / 100;
      }
      if (!entry.lastOrderDate) {
        entry.lastOrderDate = o.createdAt.toISOString();
        entry.lastOrderNumber = o.orderNumber;
      }
      if (o.branchName) {
        entry.branchesSeen.add(o.branchName);
      }

      statsMap.set(o.customerId, entry);
    }

    return customerList.map((c) => {
      const stats = statsMap.get(c.id);
      const allBranches = stats && stats.branchesSeen.size > 0 ? Array.from(stats.branchesSeen).join(", ") : null;

      return {
        id: c.id,
        _id: c.id,
        name: c.name,
        phoneNumber: c.phoneNumber,
        email: c.email,
        branchId: c.branchId,
        branchName: c.branchName ?? (stats?.branchesSeen.values().next().value ?? null),
        allBranches,
        status: c.status,
        statusNote: c.statusNote,
        isRegistered: c.isRegistered,
        isVerified: c.isVerified,
        loyaltyPoints: c.loyaltyPoints,
        orderCount: stats?.orderCount ?? 0,
        completedOrderCount: stats?.completedCount ?? 0,
        totalSpent: Math.round((stats?.totalSpent ?? 0) * 100) / 100,
        lastOrderDate: stats?.lastOrderDate ?? null,
        lastOrderNumber: stats?.lastOrderNumber ?? null,
        createdAt: c.createdAt.toISOString(),
      };
    });
  },

  async getCustomerStats(branchId?: string) {
    const customerConds = [isNull(customers.deletedAt)];
    if (branchId) {
      customerConds.push(eq(customers.branchId, branchId));
    }

    const allCustomers = await db
      .select({
        id: customers.id,
        status: customers.status,
        isRegistered: customers.isRegistered,
        isVerified: customers.isVerified,
        branchId: customers.branchId,
      })
      .from(customers)
      .where(and(...customerConds));

    const totalCustomers = allCustomers.length;
    const registeredCustomers = allCustomers.filter((c) => c.isRegistered).length;
    const walkInCustomers = allCustomers.filter((c) => !c.isRegistered).length;
    const activeCustomers = allCustomers.filter((c) => c.status === "active").length;
    const blockedCustomers = allCustomers.filter((c) => c.status === "blocked").length;
    const suspendedCustomers = allCustomers.filter((c) => c.status === "suspended").length;
    const restrictedCustomers = allCustomers.filter((c) => c.status === "restricted").length;
    const verifiedCustomers = allCustomers.filter((c) => c.isVerified).length;

    // Order metrics
    const orderConds = [isNull(orders.deletedAt)];
    if (branchId) {
      orderConds.push(eq(orders.branchId, branchId));
    }

    const recentOrders = await db
      .select({
        customerId: orders.customerId,
        finalPricePesewas: orders.finalPricePesewas,
        paymentStatus: orders.paymentStatus,
        branchId: orders.branchId,
      })
      .from(orders)
      .where(and(...orderConds))
      .limit(5000);

    const customersWithOrders = new Set<string>();
    let totalRevenue = 0;

    for (const o of recentOrders) {
      if (o.customerId) {
        customersWithOrders.add(o.customerId);
      }
      if (o.paymentStatus === "paid") {
        totalRevenue += Number(o.finalPricePesewas) / 100;
      }
    }

    // Branch breakdowns
    const branchList = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(isNull(branches.deletedAt), eq(branches.isActive, true)));

    const branchCustomerCounts = branchList.map((b) => {
      const fromOrders = new Set(recentOrders.filter((o) => o.branchId === b.id && o.customerId).map((o) => o.customerId!));
      const fromProfile = allCustomers.filter((c) => c.branchId === b.id).map((c) => c.id);
      const unique = new Set([...fromOrders, ...fromProfile]);
      return { branchId: b.id, branchName: b.name, customerCount: unique.size };
    });

    return {
      totalCustomers,
      registeredCustomers,
      walkInCustomers,
      activeCustomers,
      blockedCustomers,
      suspendedCustomers,
      restrictedCustomers,
      verifiedCustomers,
      customersWithActiveOrders: customersWithOrders.size,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      branchCustomerCounts,
    };
  },

  async changeCustomerStatus(
    actor: AuthenticatedUser,
    customerId: string,
    status: "active" | "blocked" | "suspended" | "restricted",
    note: string,
    meta?: RequestMeta
  ) {
    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
      .limit(1);

    if (!customer) throw new NotFoundError("Customer not found", "CUSTOMER_NOT_FOUND");
    if (customer.status === status) {
      throw new BadRequestError(`Customer is already ${status}`);
    }

    return await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          status,
          statusNote: note.trim(),
          statusChangedBy: actor.id,
          statusChangedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customerId));

      await writeAudit(
        tx,
        actor,
        "customer.status_changed",
        "customer",
        customerId,
        {
          previousStatus: customer.status,
          newStatus: status,
          note: note.trim(),
        },
        meta
      );

      return { success: true, customerId, status };
    });
  },

  async deleteCustomer(actor: AuthenticatedUser, customerId: string, meta?: RequestMeta) {
    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
      .limit(1);

    if (!customer) throw new NotFoundError("Customer not found", "CUSTOMER_NOT_FOUND");

    // Check active orders
    const [activeOrder] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.customerId, customerId),
          isNull(orders.deletedAt),
          notInArray(orders.status, ["completed", "cancelled"])
        )
      )
      .limit(1);

    if (activeOrder) {
      throw new BadRequestError("Cannot delete customer with active orders. Please complete or cancel orders first.");
    }

    return await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(customers.id, customerId));

      await writeAudit(
        tx,
        actor,
        "customer.deleted",
        "customer",
        customerId,
        { name: customer.name, phone: customer.phoneNumber },
        meta
      );

      return { success: true, customerId };
    });
  },
};
