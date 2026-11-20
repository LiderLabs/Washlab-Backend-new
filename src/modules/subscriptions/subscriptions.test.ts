import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import { orders } from "../../platform/db/schema/orders.js";
import { admins } from "../../platform/db/schema/staff.js";
import { customerSubscriptions, subscriptionOtps, subscriptionPlans } from "../../platform/db/schema/subscriptions.js";
import { subscriptionUsages } from "../../platform/db/schema/subscription-usages.js";
import { customers } from "../../platform/db/schema/customers.js";
import { buildApp } from "../../app.js";
import { stationService } from "../station/service.js";
import { settleSubscriptionPayment } from "../payments/settle.js";
import { destroyBranch, makeBranch } from "../cash/test-helpers.js";
import { subscriptionService } from "./service.js";

let fixture: Awaited<ReturnType<typeof makeBranch>>;
let adminId: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const referenceBase = `SUB-test-${crypto.randomBytes(6).toString("hex")}`;
const subscriptionIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  fixture = await makeBranch("SB");
  const [admin] = await db
    .insert(admins)
    .values({
      name: "Subscription Test Admin",
      email: `subscription-${crypto.randomBytes(4).toString("hex")}@test.local`,
      clerkUserId: `subscription-test-${crypto.randomBytes(4).toString("hex")}`,
      role: "admin",
    })
    .returning({ id: admins.id });
  adminId = admin!.id;
}, 30_000);

afterAll(async () => {
  if (!adminId || !fixture) {
    await app.close();
    return;
  }
  if (subscriptionIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, subscriptionIds));
    await db.delete(subscriptionUsages).where(inArray(subscriptionUsages.subscriptionId, subscriptionIds));
    await db.delete(subscriptionOtps).where(inArray(subscriptionOtps.subscriptionId, subscriptionIds));
    await db.delete(customerSubscriptions).where(inArray(customerSubscriptions.id, subscriptionIds));
  }
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.createdByAdminId, adminId));
  await db.delete(admins).where(eq(admins.id, adminId));
  await destroyBranch(fixture);
  await app.close();
});

async function createPendingSubscription(reference: string) {
  const [customer] = await db.select({ phoneNumber: customers.phoneNumber }).from(customers).where(eq(customers.id, fixture.customerId));
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: "Test plan",
      pricePesewas: 12500n,
      loadsIncluded: 5,
      validityDays: 30,
      createdByAdminId: adminId,
    })
    .returning({ id: subscriptionPlans.id });
  const [sub] = await db
    .insert(customerSubscriptions)
    .values({
      customerId: fixture.customerId,
      phoneNumber: customer!.phoneNumber,
      customerName: "Test Customer",
      planId: plan!.id,
      planName: "Test plan",
      planPricePesewas: 12500n,
      loadsTotal: 5,
      validityDays: 30,
      code: `WL-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      status: "pending_payment",
      paymentReference: reference,
    })
    .returning();
  subscriptionIds.push(sub!.id);
  return sub!;
}

describe("subscription Paystack settlement", () => {
  it("activates a pending subscription once and sets its validity window", async () => {
    const reference = `${referenceBase}-active`;
    const sub = await createPendingSubscription(reference);
    const startedAt = Date.now();
    const result = await settleSubscriptionPayment(reference, {
      status: "success",
      reference,
      transactionId: "subscription-test-transaction",
      amountPesewas: 12500n,
      currency: "GHS",
      channel: "mobile_money",
      paidAt: new Date(),
    }, "webhook");

    expect(result.result).toBe("activated");
    const [active] = await db.select().from(customerSubscriptions).where(eq(customerSubscriptions.id, sub.id));
    expect(active).toMatchObject({ status: "active", loadsUsed: 0 });
    expect(active!.expiresAt!.getTime()).toBeGreaterThanOrEqual(startedAt + 30 * 24 * 60 * 60 * 1000 - 1000);
    expect((await settleSubscriptionPayment(reference, {
      status: "success",
      reference,
      transactionId: "subscription-test-transaction",
      amountPesewas: 12500n,
      currency: "GHS",
      channel: "mobile_money",
      paidAt: new Date(),
    }, "webhook")).result).toBe("already_active");
  });

  it("does not activate an underpaid subscription", async () => {
    const reference = `${referenceBase}-mismatch`;
    const sub = await createPendingSubscription(reference);
    const result = await settleSubscriptionPayment(reference, {
      status: "success",
      reference,
      transactionId: "subscription-test-underpayment",
      amountPesewas: 100n,
      currency: "GHS",
      channel: "mobile_money",
      paidAt: new Date(),
    }, "webhook");

    expect(result.result).toBe("mismatch");
    const [pending] = await db.select().from(customerSubscriptions).where(eq(customerSubscriptions.id, sub.id));
    expect(pending).toMatchObject({ status: "pending_payment" });
    expect(pending!.note).toContain("PAYMENT AMOUNT MISMATCH");
  });

  it("redeems one load only after the station route verifies the attendant PIN", async () => {
    const reference = `${referenceBase}-redeem`;
    const sub = await createPendingSubscription(reference);
    await settleSubscriptionPayment(reference, {
      status: "success",
      reference,
      transactionId: "subscription-test-redemption",
      amountPesewas: 12500n,
      currency: "GHS",
      channel: "mobile_money",
      paidAt: new Date(),
    }, "webhook");

    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `SUB${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
        orderType: "walk_in",
        customerId: fixture.customerId,
        branchId: fixture.branchId,
        status: "checked_in",
        serviceType: "wash_only",
        estimatedLoads: 1,
      })
      .returning();
    const station = {
      sessionId: crypto.randomUUID(),
      branchId: fixture.branchId,
      deviceId: "subscription-test-device",
      expiresAt: new Date(Date.now() + 60_000),
      loggedInAt: new Date(),
    };
    const otp = await subscriptionService.sendOtp(station, sub.id, fixture.attendantId);
    const login = await stationService.login(
      { branchId: fixture.branchId, deviceId: "subscription-test", stationPin: "1234" },
      { ip: "127.0.0.1" }
    );
    const payload = {
      subscriptionId: sub.id,
      orderId: order!.id,
      otp: otp.otpCode,
      attendantId: fixture.attendantId,
    };

    const denied = await app.inject({
      method: "POST",
      url: "/v1/station/subscriptions/redeem",
      headers: { "x-station-token": login.stationToken },
      payload: { ...payload, pin: "0000" },
    });
    expect(denied.statusCode).toBe(401);
    expect((await db.select().from(customerSubscriptions).where(eq(customerSubscriptions.id, sub.id)))[0]!.loadsUsed).toBe(0);

    const redeemed = await app.inject({
      method: "POST",
      url: "/v1/station/subscriptions/redeem",
      headers: { "x-station-token": login.stationToken },
      payload: { ...payload, pin: fixture.pin },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toMatchObject({ tokensUsed: 1, loadsRemaining: 4 });

    const [updatedOrder] = await db.select().from(orders).where(eq(orders.id, order!.id));
    const [updatedSub] = await db.select().from(customerSubscriptions).where(eq(customerSubscriptions.id, sub.id));
    expect(updatedOrder).toMatchObject({ paymentStatus: "paid", paymentMethod: "subscription", subscriptionLoadsUsed: 1 });
    expect(updatedSub!.loadsUsed).toBe(1);
    expect(await db.select().from(subscriptionUsages).where(eq(subscriptionUsages.orderId, order!.id))).toHaveLength(1);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/station/subscriptions/redeem",
      headers: { "x-station-token": login.stationToken },
      payload: { ...payload, pin: fixture.pin },
    });
    expect(replay.statusCode).toBe(404);
  });
});
