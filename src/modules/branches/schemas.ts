import { z } from "zod";


export const branchDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  terminalId: z.string().nullable(),
  phoneNumber: z.string(),
  email: z.string().nullable(),
  address: z.string(),
  city: z.string(),
  pricingPerKgPesewas: z.string(), // BigInt serialized as string for JSON safety
  deliveryFeePesewas: z.string(),
  requireStationLogin: z.boolean(),
  weeklyOrderTarget: z.number().nullable(),
  momoNumber: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
});


export const createBranchInputSchema = z.object({
  name: z.string().min(2),
  code: z.string().min(2).max(10).toUpperCase(),
  terminalId: z.string().length(3).regex(/^\d+$/, "Terminal ID must be 3 digits").optional(),
  phoneNumber: z.string().min(8),
  email: z.string().email().optional(),
  address: z.string().min(3),
  city: z.string().min(2),
  pricingPerKgPesewas: z.number().int().nonnegative(),
  deliveryFeePesewas: z.number().int().nonnegative().default(0),
  stationPin: z.string().min(6).max(8).regex(/^\d+$/, "PIN must be 6 to 8 digits"),
  weeklyOrderTarget: z.number().int().nonnegative().optional(),
  momoNumber: z.string().optional(),
});


export const updateBranchInputSchema = createBranchInputSchema
  .omit({ stationPin: true, deliveryFeePesewas: true })
  .partial()
  .extend({
    // Declared explicitly so omitting it never resets the fee to 0
    deliveryFeePesewas: z.number().int().nonnegative().optional(),
    stationPin: z.string().min(6).max(8).regex(/^\d+$/, "PIN must be 6 to 8 digits").optional(),
  });


export type CreateBranchInput = z.infer<typeof createBranchInputSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchInputSchema>;
export type BranchDto = z.infer<typeof branchDtoSchema>;