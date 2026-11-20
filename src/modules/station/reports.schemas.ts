import { z } from "zod";

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "Not a real date");

const count = z.number().int().min(0).max(100_000);

/**
 * Fields the attendant fills in by hand. Money, outstanding, free washes, service and voucher breakdowns are always
 * computed by the server. Tokens and attendants on shift default to the computed values when left out.
 */
const manualFields = {
  date: dateString.optional(),
  attendantsOnShift: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  washerTokensUsed: count.optional(),
  dryerTokensUsed: count.optional(),
  soapUnitsUsed: count.optional(),
  washingPlanCount: count.optional(),
  technicalFaultCount: count.optional(),
  technicalFaultNotes: z.string().trim().max(2000).nullish(),
  notes: z.string().trim().max(2000).nullish(),
};

export const reportDateQuery = z.object({ date: dateString.optional() });
export const reportListQuery = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  limit: z.coerce.number().int().min(1).max(120).default(60),
  offset: z.coerce.number().int().min(0).default(0),
});
export const saveDraftBody = z.object({ ...manualFields, attendantId: z.string().uuid().optional() });
export const submitReportBody = z.object({
  ...manualFields,
  attendantId: z.string().uuid(),
  pin: z.string().min(4).max(8),
});

export type SaveDraftInput = z.infer<typeof saveDraftBody>;
export type SubmitReportInput = z.infer<typeof submitReportBody>;
