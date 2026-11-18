import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { customers } from "../../platform/db/schema/customers.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { loyaltyLedger } from "../../platform/db/schema/loyalty.js";
import { notifications } from "../../platform/db/schema/operations.js";
import { admins, attendants } from "../../platform/db/schema/staff.js";
import { ConflictError, NotFoundError } from "../../platform/errors/index.js";
import {
  normalizePhone,
  PaginationQuery,
  RegisterCustomerInput,
  UpdateCustomerProfileInput,
} from "./schemas.js";

async function findCustomerByClerk(clerkUserId: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.clerkUserId, clerkUserId), isNull(customers.deletedAt)))
    .limit(1);

  return customer ?? null;
}

async function requireCustomer(clerkUserId: string) {
  const customer = await findCustomerByClerk(clerkUserId);
  if (!customer) {
    throw new NotFoundError("Customer profile not found. Please register first.", "CUSTOMER_NOT_FOUND");
  }
  return customer;
}

export const customerService = {
  async getProfile(clerkUserId: string) {
    const customer = await requireCustomer(clerkUserId);

    const [orderStats] = await db
      .select({
        orderCount: sql<number>`count(*)::int`,
        completedOrderCount: sql<number>`count(case when ${orders.status} = 'completed' then 1 end)::int`,
      })
      .from(orders)
      .where(and(eq(orders.customerId, customer.id), isNull(orders.deletedAt)));

    return {
      id: customer.id,
      name: customer.name,
      phoneNumber: customer.phoneNumber,
      email: customer.email,
      branchId: customer.branchId,
      loyaltyPoints: customer.loyaltyPoints ?? 0,
      isVerified: customer.isVerified,
      orderCount: orderStats?.orderCount ?? 0,
      completedOrderCount: orderStats?.completedOrderCount ?? 0,
      createdAt: customer.createdAt.toISOString(),
    };
  },

  async register(clerkUserId: string, input: RegisterCustomerInput) {
    const existing = await findCustomerByClerk(clerkUserId);
    if (existing) {
      throw new ConflictError("Customer account is already registered", "CUSTOMER_ALREADY_REGISTERED");
    }

    const phone = normalizePhone(input.phoneNumber);

    // Check if there is an unlinked guest customer with this phone or email
    const [guest] = await db
      .select()
      .from(customers)
      .where(
        and(
          isNull(customers.clerkUserId),
          isNull(customers.deletedAt),
          eq(customers.phoneNumber, phone)
        )
      )
      .limit(1);

    if (guest) {
      // Link guest account to this Clerk user
      const [updated] = await db
        .update(customers)
        .set({
          clerkUserId,
          name: input.name,
          email: input.email ?? guest.email,
          branchId: input.branchId ?? guest.branchId,
          isVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, guest.id))
        .returning();

      return customerService.getProfile(clerkUserId);
    }

    // Insert new customer
    await db.insert(customers).values({
      clerkUserId,
      name: input.name,
      phoneNumber: phone,
      email: input.email,
      branchId: input.branchId,
      isVerified: true,
      loyaltyPoints: 0,
    });

    return customerService.getProfile(clerkUserId);
  },

  async updateProfile(clerkUserId: string, input: UpdateCustomerProfileInput) {
    const customer = await requireCustomer(clerkUserId);

    const updates: Partial<typeof customers.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.email !== undefined) updates.email = input.email;
    if (input.preferredBranchId !== undefined) updates.branchId = input.preferredBranchId;

    if (input.phoneNumber !== undefined) {
      const phone = normalizePhone(input.phoneNumber);
      if (phone !== customer.phoneNumber) {
        // Verify phone isn't already taken by another registered user
        const [conflict] = await db
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.phoneNumber, phone),
              isNull(customers.deletedAt),
              sql`${customers.id} != ${customer.id}`
            )
          )
          .limit(1);

        if (conflict && conflict.clerkUserId) {
          throw new ConflictError("Phone number is already associated with another account", "PHONE_TAKEN");
        }
        updates.phoneNumber = phone;
      }
    }

    await db.update(customers).set(updates).where(eq(customers.id, customer.id));

    return customerService.getProfile(clerkUserId);
  },

  async checkRole(clerkUserId: string) {
    const [admin] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.clerkUserId, clerkUserId), isNull(admins.deletedAt)))
      .limit(1);

    if (admin) {
      return { isAdmin: true, isAttendant: false, isCustomer: false };
    }

    const [attendant] = await db
      .select({ id: attendants.id })
      .from(attendants)
      .where(and(eq(attendants.clerkUserId, clerkUserId), isNull(attendants.deletedAt)))
      .limit(1);

    if (attendant) {
      return { isAdmin: false, isAttendant: true, isCustomer: false };
    }

    return { isAdmin: false, isAttendant: false, isCustomer: true };
  },

  async getOrders(clerkUserId: string, query: PaginationQuery) {
    const customer = await requireCustomer(clerkUserId);

    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.customerId, customer.id), isNull(orders.deletedAt)))
      .orderBy(desc(orders.placedAt))
      .limit(query.limit);

    return rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      orderType: o.orderType,
      serviceType: o.serviceType,
      status: o.status,
      paymentStatus: o.paymentStatus,
      paymentMethod: o.paymentMethod,
      weightKg: o.weightKg ? Number(o.weightKg) : null,
      itemCount: o.itemCount,
      estimatedLoads: o.estimatedLoads,
      isDelivery: o.isDelivery,
      deliveryAddress: o.deliveryAddress,
      deliveryPhone: o.deliveryPhone,
      deliveryHall: o.deliveryHall,
      deliveryRoom: o.deliveryRoom,
      basePricePesewas: Number(o.basePricePesewas),
      deliveryFeePesewas: Number(o.deliveryFeePesewas),
      discountPesewas: Number(o.discountPesewas),
      finalPricePesewas: Number(o.finalPricePesewas),
      placedAt: o.placedAt.toISOString(),
      completedAt: o.completedAt ? o.completedAt.toISOString() : null,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    }));
  },

  async getActiveOrders(clerkUserId: string) {
    const customer = await requireCustomer(clerkUserId);

    const rows = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.customerId, customer.id),
          isNull(orders.deletedAt),
          notInArray(orders.status, ["completed", "cancelled"])
        )
      )
      .orderBy(desc(orders.placedAt));

    return rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      orderType: o.orderType,
      serviceType: o.serviceType,
      status: o.status,
      paymentStatus: o.paymentStatus,
      paymentMethod: o.paymentMethod,
      weightKg: o.weightKg ? Number(o.weightKg) : null,
      itemCount: o.itemCount,
      estimatedLoads: o.estimatedLoads,
      isDelivery: o.isDelivery,
      deliveryAddress: o.deliveryAddress,
      deliveryPhone: o.deliveryPhone,
      deliveryHall: o.deliveryHall,
      deliveryRoom: o.deliveryRoom,
      basePricePesewas: Number(o.basePricePesewas),
      deliveryFeePesewas: Number(o.deliveryFeePesewas),
      discountPesewas: Number(o.discountPesewas),
      finalPricePesewas: Number(o.finalPricePesewas),
      placedAt: o.placedAt.toISOString(),
      completedAt: o.completedAt ? o.completedAt.toISOString() : null,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    }));
  },

  async getLoyaltyBalance(clerkUserId: string) {
    const customer = await requireCustomer(clerkUserId);

    const [stats] = await db
      .select({
        totalEarned: sql<number>`coalesce(sum(case when ${loyaltyLedger.pointsDelta} > 0 then ${loyaltyLedger.pointsDelta} else 0 end), 0)::int`,
        totalRedeemed: sql<number>`coalesce(sum(case when ${loyaltyLedger.pointsDelta} < 0 then abs(${loyaltyLedger.pointsDelta}) else 0 end), 0)::int`,
      })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.customerId, customer.id));

    return {
      points: customer.loyaltyPoints ?? 0,
      totalEarned: stats?.totalEarned ?? 0,
      totalRedeemed: stats?.totalRedeemed ?? 0,
    };
  },

  async getLoyaltyTransactions(clerkUserId: string, query: PaginationQuery) {
    const customer = await requireCustomer(clerkUserId);

    const rows = await db
      .select()
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.customerId, customer.id))
      .orderBy(desc(loyaltyLedger.createdAt))
      .limit(query.limit);

    return rows.map((r) => ({
      id: r.id,
      pointsDelta: r.pointsDelta,
      balanceAfter: r.balanceAfter,
      reason: r.reason,
      orderId: r.orderId,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  async getNotifications(clerkUserId: string, query: PaginationQuery) {
    const customer = await requireCustomer(clerkUserId);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientType, "customer"),
          eq(notifications.recipientId, customer.id)
        )
      )
      .orderBy(desc(notifications.createdAt))
      .limit(query.limit);

    return rows.map((n) => ({
      id: n.id,
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

  async getUnreadNotificationsCount(clerkUserId: string) {
    const customer = await requireCustomer(clerkUserId);

    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientType, "customer"),
          eq(notifications.recipientId, customer.id),
          eq(notifications.isRead, false)
        )
      );

    return { unreadCount: result?.count ?? 0 };
  },

  async markNotificationRead(clerkUserId: string, notificationId: string) {
    const customer = await requireCustomer(clerkUserId);

    await db
      .update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.recipientType, "customer"),
          eq(notifications.recipientId, customer.id)
        )
      );

    return { success: true };
  },

  async markAllNotificationsRead(clerkUserId: string) {
    const customer = await requireCustomer(clerkUserId);

    await db
      .update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(notifications.recipientType, "customer"),
          eq(notifications.recipientId, customer.id),
          eq(notifications.isRead, false)
        )
      );

    return { success: true };
  },

  async deleteNotification(clerkUserId: string, notificationId: string) {
    const customer = await requireCustomer(clerkUserId);

    await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.recipientType, "customer"),
          eq(notifications.recipientId, customer.id)
        )
      );

    return { success: true };
  },

  async getPayments(clerkUserId: string, query: PaginationQuery) {
    const customer = await requireCustomer(clerkUserId);

    const rows = await db
      .select({
        payment: payments,
        orderNumber: orders.orderNumber,
      })
      .from(payments)
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(eq(payments.customerId, customer.id))
      .orderBy(desc(payments.createdAt))
      .limit(query.limit);

    return rows.map((r) => ({
      id: r.payment.id,
      orderId: r.payment.orderId,
      orderNumber: r.orderNumber,
      amountPesewas: r.payment.amountPesewas.toString(),
      currency: r.payment.currency,
      method: r.payment.method,
      status: r.payment.status,
      createdAt: r.payment.createdAt.toISOString(),
    }));
  },
};
