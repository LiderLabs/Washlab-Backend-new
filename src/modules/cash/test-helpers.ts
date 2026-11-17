import { inArray } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import {
  cashCredits,
  cashDeductions,
  cashLedger,
  cashReconAllocations,
  cashReconTransactions,
} from "../../platform/db/schema/cash.js";

/** Test cleanup: cash tables restrict branch deletion on purpose (financial records), so tests purge them first. */
export async function purgeCash(branchIds: string[]) {
  if (!branchIds.length) return;
  await db.delete(cashReconAllocations).where(inArray(cashReconAllocations.branchId, branchIds));
  await db.delete(cashCredits).where(inArray(cashCredits.branchId, branchIds));
  await db.delete(cashReconTransactions).where(inArray(cashReconTransactions.branchId, branchIds));
  await db.delete(cashDeductions).where(inArray(cashDeductions.branchId, branchIds));
  await db.delete(cashLedger).where(inArray(cashLedger.branchId, branchIds));
}

// ---------------- shared fixtures for payment / cash tests ----------------
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { branches } from "../../platform/db/schema/branches.js";
import { customers } from "../../platform/db/schema/customers.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments, webhookEvents } from "../../platform/db/schema/payments.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import { hashPin } from "../../platform/crypto/pin.js";
import type { PaystackClient, PaystackVerification } from "../../platform/paystack/index.js";

export async function makeBranch(tag: string) {
  const run = crypto.randomBytes(3).toString("hex");
  const [b] = await db
    .insert(branches)
    .values({
      name: `${tag} ${run}`,
      code: `${tag}${run}`.slice(0, 32),
      phoneNumber: "0000000000",
      address: "Test",
      city: "Test",
      email: `${tag}${run}@test.local`,
      pricingPerKgPesewas: 4000n,
      deliveryFeePesewas: 500n,
      stationPinHash: await hashPin("1234"),
    })
    .returning({ id: branches.id });
  const [a] = await db
    .insert(attendants)
    .values({
      branchId: b!.id,
      name: `att-${run}`,
      email: `att-${run}@test.local`,
      phoneNumber: "1",
      status: "active",
      passcodeHash: await hashPin("4321"),
    })
    .returning({ id: attendants.id });
  await db.insert(attendanceLogs).values({ attendantId: a!.id, branchId: b!.id, deviceId: "fx" });
  const [c] = await db
    .insert(customers)
    .values({ name: "Fixture Customer", phoneNumber: `+23324${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}` })
    .returning({ id: customers.id });
  return { branchId: b!.id, attendantId: a!.id, customerId: c!.id, pin: "4321", run };
}

export async function destroyBranch(f: { branchId: string; customerId: string }) {
  const os = await db.select({ id: orders.id }).from(orders).where(eq(orders.branchId, f.branchId));
  if (os.length) await db.delete(payments).where(inArray(payments.orderId, os.map((o) => o.id)));
  await purgeCash([f.branchId]);
  await db.delete(orders).where(eq(orders.branchId, f.branchId));
  await db.delete(attendanceLogs).where(eq(attendanceLogs.branchId, f.branchId));
  await db.delete(attendants).where(eq(attendants.branchId, f.branchId));
  await db.delete(customers).where(eq(customers.id, f.customerId));
  await db.delete(branches).where(eq(branches.id, f.branchId));
}

export const wipeWebhookEvents = (ids: string[]) =>
  ids.length ? db.delete(webhookEvents).where(inArray(webhookEvents.eventId, ids)) : Promise.resolve();

/** A Paystack stand-in: no network. Tests set what verify() should say per reference. */
export class FakePaystack implements PaystackClient {
  charges: { reference: string; amountPesewas: bigint; phone: string; network: string; email: string }[] = [];
  otps: { reference: string; otp: string }[] = [];
  verifyFor = new Map<string, Partial<PaystackVerification>>();
  chargeStatus = "send_otp";
  chargeError: Error | null = null;
  onCharge?: (reference: string) => Promise<void> | void;
  otpStatus = "success";

  async chargeMobileMoney(i: { reference: string; amountPesewas: bigint; email: string; phone: string; network: any }) {
    await this.onCharge?.(i.reference);
    if (this.chargeError) throw this.chargeError;
    this.charges.push(i);
    return { status: this.chargeStatus, displayText: "Approve on your phone", reference: i.reference };
  }
  async submitOtp(i: { reference: string; otp: string }) {
    this.otps.push(i);
    return { status: this.otpStatus, displayText: "", reference: i.reference };
  }
  async verify(reference: string): Promise<PaystackVerification> {
    const v = this.verifyFor.get(reference);
    return {
      status: "abandoned",
      reference,
      transactionId: "111",
      amountPesewas: 0n,
      currency: "GHS",
      channel: "mobile_money",
      paidAt: new Date(),
      ...v,
    };
  }
}
