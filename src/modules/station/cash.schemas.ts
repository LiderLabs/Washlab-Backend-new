import { z } from "zod";

const pin = z.string().min(4).max(8);
const attendantId = z.string().uuid();
/** Whole pesewas. Capped so a typo can't ask Paystack for a silly amount. */
const pesewas = z.number().int().positive().max(100_000_000);

export const deductionBody = z.object({
  attendantId,
  pin,
  amountPesewas: pesewas,
  reason: z.string().trim().min(1).max(500),
});

export const initiateReconBody = z.object({
  attendantId,
  pin,
  senderMomoNumber: z.string().trim().min(9).max(16),
  network: z.enum(["mtn", "vodafone", "airteltigo"]).optional(),
  amountPesewas: pesewas,
});

export const referenceParams = z.object({ reference: z.string().min(8).max(128) });
export const otpBody = z.object({ otp: z.string().trim().regex(/^\d{4,8}$/, "Enter the code from the SMS") });
export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(31),
  offset: z.coerce.number().int().min(0).default(0),
});

export const finalizeBody = z.object({ reference: z.string().min(8).max(128) });
export const finalizeResponse = z.object({
  status: z.string(),
  orderId: z.string().uuid(),
  paymentStatus: z.string(),
});

export const summaryResponse = z.object({
  branchId: z.string().uuid(),
  branchName: z.string(),
  branchEmail: z.string().nullable(),
  momoNumber: z.string().nullable(),
  date: z.string(),
  totalCashPesewas: z.number(),
  orderCount: z.number(),
  todaySentPesewas: z.number(),
  todayDeductedPesewas: z.number(),
  outstandingCashPesewas: z.number(),
  allTimeOutstandingPesewas: z.number(),
  creditBalancePesewas: z.number(),
  totalEverCollectedPesewas: z.number(),
  totalEverSentPesewas: z.number(),
  totalEverDeductedPesewas: z.number(),
  paystackFeePesewas: z.number(),
  amountAfterFeePesewas: z.number(),
  alreadyReconciled: z.boolean(),
  reconciliationStatus: z.string().nullable(),
});
