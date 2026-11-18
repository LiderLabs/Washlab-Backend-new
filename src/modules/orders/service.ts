import { and, desc, eq, ilike, isNull, notInArray, or, sql, SQL } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { branchServices } from "../../platform/db/schema/catalog.js";
import { customers } from "../../platform/db/schema/customers.js";
import { orders, orderStatusEvents } from "../../platform/db/schema/orders.js";
import { vouchers, voucherUsages } from "../../platform/db/schema/loyalty.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../platform/errors/index.js";
import { writeAudit } from "../../platform/audit/index.js";
import { broadcastRealtimeEvent } from "../../platform/realtime/index.js";
import type { AuthenticatedUser } from "../../platform/auth/index.js";
import { normalizePhone } from "../customers/schemas.js";
import { CreateOnlineOrderInput, OrderListQuery } from "./schemas.js";

type RequestMeta = { ip?: string; userAgent?: string };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextOrderNumber(tx: Tx, branchCode: string) {
  const res: any = await tx.execute(sql`SELECT nextval('order_number_seq') AS n`);
  const rows = Array.isArray(res) ? res : res.rows;
  const n = String(rows[0].n).padStart(4, "0");
  return `${branchCode.slice(0, 2).toUpperCase()}${n}`;
}

export const orderService = {
  async createOnlineOrder(
    user: AuthenticatedUser | undefined,
    input: CreateOnlineOrderInput,
    meta: RequestMeta
  ) {
    const phone = normalizePhone(input.customerPhoneNumber);

    // 1. Resolve or create customer
    let customerId: string;
    let customerName = input.customerName;

    if (user?.id) {
      // Authenticated user
      let [cust] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.clerkUserId, user.id), isNull(customers.deletedAt)))
        .limit(1);

      if (!cust) {
        // First order before register called
        const [created] = await db
          .insert(customers)
          .values({
            clerkUserId: user.id,
            name: input.customerName,
            phoneNumber: phone,
            email: input.customerEmail,
            branchId: input.branchId,
            isVerified: true,
          })
          .returning();
        cust = created!;
      } else {
        // Update contact details if provided
        await db
          .update(customers)
          .set({
            name: input.customerName,
            phoneNumber: phone,
            ...(input.customerEmail ? { email: input.customerEmail } : {}),
            updatedAt: new Date(),
          })
          .where(eq(customers.id, cust.id));
      }
      customerId = cust.id;
      customerName = cust.name;
    } else {
      // Guest customer
      let [guest] = await db
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.phoneNumber, phone),
            isNull(customers.deletedAt)
          )
        )
        .limit(1);

      if (!guest) {
        const [created] = await db
          .insert(customers)
          .values({
            name: input.customerName,
            phoneNumber: phone,
            email: input.customerEmail,
            branchId: input.branchId,
            isVerified: false,
          })
          .returning();
        guest = created!;
      }
      customerId = guest.id;
      customerName = guest.name;
    }

    // 2. Load branch and verify active
    const [branch] = await db
      .select()
      .from(branches)
      .where(and(eq(branches.id, input.branchId), isNull(branches.deletedAt)))
      .limit(1);

    if (!branch || !branch.isActive) {
      throw new NotFoundError("Branch not found or inactive", "BRANCH_UNAVAILABLE");
    }

    // 3. Price calculation
    const [service] = await db
      .select()
      .from(branchServices)
      .where(
        and(
          eq(branchServices.branchId, branch.id),
          eq(branchServices.code, input.serviceType),
          isNull(branchServices.deletedAt)
        )
      )
      .limit(1);

    const pricePerLoad = service?.pricePesewas ?? branch.pricingPerKgPesewas;
    const whitesExtra = input.whitesSeparate ? 1 : 0;
    const loads = Math.max(1, Math.ceil(input.estimatedWeight / 8) + whitesExtra);
    const basePricePesewas = BigInt(loads) * pricePerLoad;
    const deliveryFeePesewas = input.isDelivery ? branch.deliveryFeePesewas : 0n;

    // Check voucher if applied
    let discountPesewas = 0n;
    let appliedVoucherId: string | null = null;
    if (input.voucherCode) {
      const [v] = await db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.code, input.voucherCode.trim().toUpperCase()),
            eq(vouchers.isActive, true),
            or(isNull(vouchers.branchId), eq(vouchers.branchId, branch.id))
          )
        )
        .limit(1);

      if (v && (!v.expiresAt || v.expiresAt > new Date())) {
        appliedVoucherId = v.id;
        if (v.discountType === "fixed") {
          discountPesewas = v.discountValue;
        } else if (v.discountType === "percentage") {
          discountPesewas = (basePricePesewas * v.discountValue) / 100n;
        } else if (v.discountType === "free_wash") {
          discountPesewas = basePricePesewas;
        }
        if (discountPesewas > basePricePesewas) discountPesewas = basePricePesewas;
      }
    }

    const finalPricePesewas = basePricePesewas + deliveryFeePesewas - discountPesewas;

    // 4. Create order transaction
    const newOrder = await db.transaction(async (tx) => {
      const orderNumber = await nextOrderNumber(tx, branch.code);

      const [orderRow] = await tx
        .insert(orders)
        .values({
          orderNumber,
          customerId,
          branchId: branch.id,
          orderType: "online",
          serviceType: input.serviceType,
          weightKg: input.estimatedWeight.toFixed(2),
          itemCount: input.itemCount ?? 1,
          estimatedLoads: loads,
          whitesSeparate: input.whitesSeparate ?? false,
          notes: input.notes,
          isDelivery: input.isDelivery,
          deliveryAddress: input.deliveryAddress,
          deliveryPhone: input.deliveryPhone ?? phone,
          deliveryHall: input.deliveryHall,
          deliveryRoom: input.deliveryRoom,
          basePricePesewas,
          deliveryFeePesewas,
          discountPesewas,
          finalPricePesewas,
          status: "pending_dropoff",
          paymentStatus: "pending",
        })
        .returning();

      await tx.insert(orderStatusEvents).values({
        orderId: orderRow!.id,
        toStatus: "pending_dropoff",
        changedByUserId: customerId,
        changedByRole: "customer",
        notes: "Order placed online",
      });

      if (appliedVoucherId) {
        await tx.insert(voucherUsages).values({
          voucherId: appliedVoucherId,
          orderId: orderRow!.id,
          customerId,
          discountAppliedPesewas: discountPesewas,
        });
        await tx
          .update(vouchers)
          .set({ currentUsageCount: sql`${vouchers.currentUsageCount} + 1` })
          .where(eq(vouchers.id, appliedVoucherId));
      }

      await writeAudit(tx, {
        actorId: customerId,
        actorRole: "customer",
        action: "order.create_online",
        entityType: "order",
        entityId: orderRow!.id,
        changes: {
          orderNumber,
          branchId: branch.id,
          finalPricePesewas: finalPricePesewas.toString(),
        },
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });

      return orderRow!;
    });

    broadcastRealtimeEvent(`branch:${branch.id}`, "order.created", {
      orderId: newOrder.id,
      orderNumber: newOrder.orderNumber,
      status: newOrder.status,
    });

    return {
      id: newOrder.id,
      orderNumber: newOrder.orderNumber,
      orderType: newOrder.orderType,
      serviceType: newOrder.serviceType,
      status: newOrder.status,
      paymentStatus: newOrder.paymentStatus,
      paymentMethod: newOrder.paymentMethod,
      weightKg: Number(newOrder.weightKg),
      itemCount: newOrder.itemCount,
      estimatedLoads: newOrder.estimatedLoads,
      isDelivery: newOrder.isDelivery,
      deliveryAddress: newOrder.deliveryAddress,
      deliveryPhone: newOrder.deliveryPhone,
      deliveryHall: newOrder.deliveryHall,
      deliveryRoom: newOrder.deliveryRoom,
      basePricePesewas: Number(newOrder.basePricePesewas),
      deliveryFeePesewas: Number(newOrder.deliveryFeePesewas),
      discountPesewas: Number(newOrder.discountPesewas),
      finalPricePesewas: Number(newOrder.finalPricePesewas),
      placedAt: newOrder.placedAt.toISOString(),
      completedAt: newOrder.completedAt ? newOrder.completedAt.toISOString() : null,
      createdAt: newOrder.createdAt.toISOString(),
      updatedAt: newOrder.updatedAt.toISOString(),
    };
  },

  async trackOrderByNumber(orderNumber: string) {
    const [row] = await db
      .select({
        order: orders,
        customer: customers,
        branch: branches,
      })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .where(and(eq(orders.orderNumber, orderNumber.trim().toUpperCase()), isNull(orders.deletedAt)))
      .limit(1);

    if (!row) {
      throw new NotFoundError(`Order ${orderNumber} not found`, "ORDER_NOT_FOUND");
    }

    const history = await db
      .select()
      .from(orderStatusEvents)
      .where(eq(orderStatusEvents.orderId, row.order.id))
      .orderBy(orderStatusEvents.createdAt);

    return {
      id: row.order.id,
      orderNumber: row.order.orderNumber,
      orderType: row.order.orderType,
      serviceType: row.order.serviceType,
      status: row.order.status,
      paymentStatus: row.order.paymentStatus,
      paymentMethod: row.order.paymentMethod,
      weightKg: row.order.weightKg ? Number(row.order.weightKg) : null,
      itemCount: row.order.itemCount,
      estimatedLoads: row.order.estimatedLoads,
      isDelivery: row.order.isDelivery,
      deliveryAddress: row.order.deliveryAddress,
      deliveryPhone: row.order.deliveryPhone,
      deliveryHall: row.order.deliveryHall,
      deliveryRoom: row.order.deliveryRoom,
      basePricePesewas: Number(row.order.basePricePesewas),
      deliveryFeePesewas: Number(row.order.deliveryFeePesewas),
      discountPesewas: Number(row.order.discountPesewas),
      finalPricePesewas: Number(row.order.finalPricePesewas),
      placedAt: row.order.placedAt.toISOString(),
      completedAt: row.order.completedAt ? row.order.completedAt.toISOString() : null,
      branch: {
        id: row.branch.id,
        name: row.branch.name,
        code: row.branch.code,
        phoneNumber: row.branch.phoneNumber,
        address: row.branch.address,
        city: row.branch.city,
      },
      customer: {
        id: row.customer.id,
        name: row.customer.name,
        phoneNumber: row.customer.phoneNumber,
      },
      history: history.map((h) => ({
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        notes: h.notes,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  },

  async getOrderById(user: AuthenticatedUser, orderId: string) {
    const [row] = await db
      .select({
        order: orders,
        customer: customers,
        branch: branches,
      })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);

    if (!row) {
      throw new NotFoundError("Order not found", "ORDER_NOT_FOUND");
    }

    if (user.role === "customer" && row.customer.clerkUserId !== user.id) {
      throw new ForbiddenError("You do not have access to this order", "FORBIDDEN");
    }
    if (user.role === "attendant" && user.branchId !== row.order.branchId) {
      throw new ForbiddenError("You do not have access to this order", "FORBIDDEN");
    }

    const history = await db
      .select()
      .from(orderStatusEvents)
      .where(eq(orderStatusEvents.orderId, row.order.id))
      .orderBy(orderStatusEvents.createdAt);

    return {
      id: row.order.id,
      orderNumber: row.order.orderNumber,
      orderType: row.order.orderType,
      serviceType: row.order.serviceType,
      status: row.order.status,
      paymentStatus: row.order.paymentStatus,
      paymentMethod: row.order.paymentMethod,
      weightKg: row.order.weightKg ? Number(row.order.weightKg) : null,
      itemCount: row.order.itemCount,
      estimatedLoads: row.order.estimatedLoads,
      isDelivery: row.order.isDelivery,
      deliveryAddress: row.order.deliveryAddress,
      deliveryPhone: row.order.deliveryPhone,
      deliveryHall: row.order.deliveryHall,
      deliveryRoom: row.order.deliveryRoom,
      basePricePesewas: Number(row.order.basePricePesewas),
      deliveryFeePesewas: Number(row.order.deliveryFeePesewas),
      discountPesewas: Number(row.order.discountPesewas),
      finalPricePesewas: Number(row.order.finalPricePesewas),
      placedAt: row.order.placedAt.toISOString(),
      completedAt: row.order.completedAt ? row.order.completedAt.toISOString() : null,
      branch: {
        id: row.branch.id,
        name: row.branch.name,
        code: row.branch.code,
        phoneNumber: row.branch.phoneNumber,
        address: row.branch.address,
        city: row.branch.city,
      },
      customer: {
        id: row.customer.id,
        name: row.customer.name,
        phoneNumber: row.customer.phoneNumber,
      },
      history: history.map((h) => ({
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        notes: h.notes,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  },

  async listOrders(user: AuthenticatedUser, query: OrderListQuery) {
    const conds: (SQL | undefined)[] = [isNull(orders.deletedAt)];

    if (user.role === "customer") {
      const [cust] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.clerkUserId, user.id), isNull(customers.deletedAt)))
        .limit(1);

      if (!cust) return { items: [], nextCursor: null, limit: query.limit };
      conds.push(eq(orders.customerId, cust.id));
    } else if (user.role === "attendant") {
      conds.push(eq(orders.branchId, user.branchId!));
    } else if (query.branchId) {
      conds.push(eq(orders.branchId, query.branchId));
    }

    if (query.status) {
      conds.push(eq(orders.status, query.status as any));
    }

    const rows = await db
      .select({
        order: orders,
        customer: customers,
      })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(...conds))
      .orderBy(desc(orders.placedAt))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const hasNext = rows.length > query.limit;
    const nextCursor = hasNext && page.length > 0 ? page[page.length - 1]!.order.id : null;

    return {
      items: page.map((r) => ({
        id: r.order.id,
        orderNumber: r.order.orderNumber,
        orderType: r.order.orderType,
        serviceType: r.order.serviceType,
        status: r.order.status,
        paymentStatus: r.order.paymentStatus,
        paymentMethod: r.order.paymentMethod,
        weightKg: r.order.weightKg ? Number(r.order.weightKg) : null,
        itemCount: r.order.itemCount,
        estimatedLoads: r.order.estimatedLoads,
        finalPricePesewas: Number(r.order.finalPricePesewas),
        placedAt: r.order.placedAt.toISOString(),
        customer: {
          id: r.customer.id,
          name: r.customer.name,
          phoneNumber: r.customer.phoneNumber,
        },
      })),
      nextCursor,
      limit: query.limit,
    };
  },
};
