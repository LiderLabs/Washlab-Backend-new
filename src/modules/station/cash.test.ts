import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { attendants } from "../../platform/db/schema/staff.js";
import { cashCredits, cashLedger, cashReconAllocations, cashReconTransactions } from "../../platform/db/schema/cash.js";
import { setPaystackClient } from "../../platform/paystack/index.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";
import { settleRecon } from "../cash/recon.service.js";
import { addCollected } from "../cash/ledger.js";
import { destroyBranch, FakePaystack, makeBranch } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
let g: Awaited<ReturnType<typeof makeBranch>>; // another branch
let token: string;
let otherToken: string;
const fake = new FakePaystack();
const meta = { ip: "127.0.0.1", userAgent: "vitest" };
const hdr = (t: string) => ({ "x-station-token": t });
const post = (url: string, payload: object, t = token) => app.inject({ method: "POST", url: `/v1/station/cash${url}`, headers: hdr(t), payload });
const get = (url: string, t = token) => app.inject({ method: "GET", url: `/v1/station/cash${url}`, headers: hdr(t) });
const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12));
const collect = (n: number, amt: bigint) => db.transaction((tx) => addCollected(tx, f.branchId, day(n), amt));
const money = { attendantId: "", pin: "" };

async function resetCash() {
  await db.delete(cashReconAllocations).where(eq(cashReconAllocations.branchId, f.branchId));
  await db.delete(cashCredits).where(eq(cashCredits.branchId, f.branchId));
  await db.delete(cashReconTransactions).where(eq(cashReconTransactions.branchId, f.branchId));
  await db.delete(cashLedger).where(eq(cashLedger.branchId, f.branchId));
  await db.update(attendants).set({ failedAttempts: 0, lockedUntil: null }).where(eq(attendants.id, f.attendantId));
}

beforeAll(async () => {
  setPaystackClient(fake);
  app = await buildApp();
  await app.ready();
  f = await makeBranch("CR");
  g = await makeBranch("CQ");
  token = (await stationService.login({ branchId: f.branchId, deviceId: "cr", stationPin: "1234" }, meta)).stationToken;
  otherToken = (await stationService.login({ branchId: g.branchId, deviceId: "cq", stationPin: "1234" }, meta)).stationToken;
  money.attendantId = f.attendantId;
  money.pin = f.pin;
}, 30_000);

beforeEach(async () => {
  await resetCash();
  fake.charges = [];
  fake.otps = [];
  fake.verifyFor.clear();
  fake.chargeError = null;
  fake.chargeStatus = "send_otp";
  fake.otpStatus = "success";
  fake.onCharge = undefined;
});

afterAll(async () => {
  setPaystackClient(null);
  await destroyBranch(f);
  await destroyBranch(g);
  await app.close();
});

describe("summary and history read one ledger", () => {
  it("shows what is owed across all days, and matches the history page", async () => {
    await collect(1, 5000n);
    await collect(2, 3000n);
    const s = (await get("/summary")).json();
    expect(s.allTimeOutstandingPesewas).toBe(8000);
    expect(s.totalEverCollectedPesewas).toBe(8000);
    const h = (await get("/history")).json();
    const sum = h.days.reduce((a: number, d: any) => a + d.outstandingPesewas, 0);
    expect(sum).toBe(s.allTimeOutstandingPesewas); // main page and history can't disagree
  });

  it("computes Paystack's 1.95% fee on today's outstanding", async () => {
    await db.transaction((tx) => addCollected(tx, f.branchId, new Date(), 10_000n));
    const s = (await get("/summary")).json();
    expect(s.outstandingCashPesewas).toBe(10_000);
    expect(s.paystackFeePesewas).toBe(195);
    expect(s.amountAfterFeePesewas).toBe(9805);
  });

  it("only sees its own branch", async () => {
    await collect(1, 5000n);
    const s = (await get("/summary", otherToken)).json();
    expect(s.allTimeOutstandingPesewas).toBe(0);
  });
});

describe("deductions", () => {
  it("need the attendant's PIN, and reduce what is owed", async () => {
    await db.transaction((tx) => addCollected(tx, f.branchId, new Date(), 5000n));
    const bad = await post("/deductions", { ...money, pin: "0000", amountPesewas: 1000, reason: "Soap" });
    expect(bad.statusCode).toBe(401);
    const ok = await post("/deductions", { ...money, amountPesewas: 1000, reason: "Soap" });
    expect(ok.statusCode).toBe(200);
    expect((await get("/summary")).json().allTimeOutstandingPesewas).toBe(4000);
    expect((await get("/deductions")).json()).toHaveLength(1);
  });
});

describe("sending cash to the company", () => {
  it("saves the record BEFORE charging Paystack", async () => {
    await collect(1, 5000n);
    let rowAtChargeTime: any;
    fake.onCharge = async (reference) => {
      [rowAtChargeTime] = await db.select().from(cashReconTransactions).where(eq(cashReconTransactions.paystackReference, reference));
    };
    const r = await post("/reconciliations", { ...money, senderMomoNumber: "+233241234567", amountPesewas: 5000 });
    expect(r.statusCode).toBe(200);
    expect(rowAtChargeTime).toBeTruthy();
    expect(rowAtChargeTime.status).toBe("pending");
    expect(r.json()).toMatchObject({ status: "send_otp", needsOtp: true, network: "mtn" });
    expect(fake.charges[0]).toMatchObject({ phone: "0241234567", network: "mtn", amountPesewas: 5000n });
  });

  it("detects the network for numbers stored as +233 (the old prefix lookup got this wrong)", async () => {
    await post("/reconciliations", { ...money, senderMomoNumber: "+233201234567", amountPesewas: 1000 });
    await post("/reconciliations", { ...money, senderMomoNumber: "0261234567", amountPesewas: 1000 });
    expect(fake.charges.map((c) => c.network)).toEqual(["vodafone", "airteltigo"]);
  });

  it("OTP then completes: split oldest-first, excess becomes credit", async () => {
    await collect(1, 5000n);
    await collect(2, 3000n);
    const r = (await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 9000 })).json();
    fake.verifyFor.set(r.reference, { status: "success", amountPesewas: 9000n });
    const otp = await post(`/reconciliations/${r.reference}/otp`, { otp: "123456" }, token);
    expect(otp.json().status).toBe("completed");
    expect(fake.otps).toEqual([{ reference: r.reference, otp: "123456" }]);

    const h = (await get("/history")).json();
    const d1 = h.days.find((d: any) => d.day === "2026-01-01");
    const d2 = h.days.find((d: any) => d.day === "2026-01-02");
    expect(d1).toMatchObject({ sentPesewas: 5000, outstandingPesewas: 0 });
    expect(d2).toMatchObject({ sentPesewas: 3000, outstandingPesewas: 0 });
    expect(h.sends[0]).toMatchObject({ status: "completed", excessPesewas: 1000 });
    const s = (await get("/summary")).json();
    expect(s.allTimeOutstandingPesewas).toBe(0);
    expect(s.creditBalancePesewas).toBe(1000);
  });

  it("does not trust an OTP reply on its own: Paystack must confirm", async () => {
    await collect(1, 5000n);
    const r = (await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 5000 })).json();
    // OTP says success but verify says still pending
    fake.verifyFor.set(r.reference, { status: "ongoing", amountPesewas: 5000n });
    const otp = await post(`/reconciliations/${r.reference}/otp`, { otp: "123456" });
    expect(otp.json().status).toBe("ongoing");
    expect((await get("/summary")).json().allTimeOutstandingPesewas).toBe(5000);
  });

  it("verify completes a send whose network dropped, and only once", async () => {
    await collect(1, 5000n);
    const r = (await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 5000 })).json();
    fake.verifyFor.set(r.reference, { status: "success", amountPesewas: 5000n });
    const [a, b] = await Promise.all([
      post(`/reconciliations/${r.reference}/verify`, {}),
      post(`/reconciliations/${r.reference}/verify`, {}),
    ]);
    expect(a.json().status).toBe("completed");
    expect(b.json().status).toBe("completed");
    const allocs = await db.select().from(cashReconAllocations).where(eq(cashReconAllocations.branchId, f.branchId));
    expect(allocs).toHaveLength(1); // not applied twice
    expect((await get("/summary")).json().totalEverSentPesewas).toBe(5000);
  });

  it("flags an amount mismatch and does not apply it", async () => {
    await collect(1, 5000n);
    const r = (await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 5000 })).json();
    fake.verifyFor.set(r.reference, { status: "success", amountPesewas: 100n });
    const res = await post(`/reconciliations/${r.reference}/verify`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("AMOUNT_MISMATCH");
    expect((await get("/summary")).json().allTimeOutstandingPesewas).toBe(5000);
  });

  it("marks a failed charge as failed and keeps nothing applied", async () => {
    await collect(1, 5000n);
    fake.chargeError = new Error("Insufficient funds");
    const r = await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 5000 });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const [t] = await db.select().from(cashReconTransactions).where(eq(cashReconTransactions.branchId, f.branchId));
    expect(t!.status).toBe("failed");
    expect((await get("/summary")).json().allTimeOutstandingPesewas).toBe(5000);
  });

  it("abandoned on Paystack's side marks the send failed", async () => {
    await collect(1, 5000n);
    const r = (await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 5000 })).json();
    fake.verifyFor.set(r.reference, { status: "abandoned" });
    expect((await post(`/reconciliations/${r.reference}/verify`, {})).json().status).toBe("abandoned");
    const [t] = await db.select().from(cashReconTransactions).where(eq(cashReconTransactions.paystackReference, r.reference));
    expect(t!.status).toBe("failed");
  });

  it("will not send without the right PIN, and counts the wrong tries", async () => {
    const bad = await post("/reconciliations", { ...money, pin: "9999", senderMomoNumber: "0241234567", amountPesewas: 1000 });
    expect(bad.statusCode).toBe(401);
    expect(fake.charges).toHaveLength(0);
    const [a] = await db.select().from(attendants).where(eq(attendants.id, f.attendantId));
    expect(a!.failedAttempts).toBe(1);
  });

  it("one branch cannot touch another branch's send", async () => {
    await collect(1, 5000n);
    const r = (await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 5000 })).json();
    const res = await post(`/reconciliations/${r.reference}/verify`, {}, otherToken);
    expect(res.statusCode).toBe(404);
  });

  it("rejects bad input", async () => {
    expect((await post("/reconciliations", { ...money, senderMomoNumber: "123", amountPesewas: 1000 })).statusCode).toBe(400);
    expect((await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 0 })).statusCode).toBe(400);
    expect((await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 1.5 })).statusCode).toBe(400);
    const r = (await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 1000 })).json();
    expect((await post(`/reconciliations/${r.reference}/otp`, { otp: "abc" })).statusCode).toBe(400);
  });

  it("settleRecon directly is idempotent (webhook + verify racing)", async () => {
    await collect(1, 5000n);
    const r = (await post("/reconciliations", { ...money, senderMomoNumber: "0241234567", amountPesewas: 5000 })).json();
    const gw = { status: "success", reference: r.reference, transactionId: "9", amountPesewas: 5000n, currency: "GHS", channel: "mobile_money", paidAt: new Date() };
    const results = await Promise.all([settleRecon(r.reference, gw), settleRecon(r.reference, gw), settleRecon(r.reference, gw)]);
    expect(results.filter((x) => x.result === "completed")).toHaveLength(1);
    expect(results.filter((x) => x.result === "already_completed")).toHaveLength(2);
  });
});
