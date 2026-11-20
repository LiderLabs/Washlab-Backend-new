import { z } from "zod";

export const reportFaultBody = z
  .object({
    attendantId: z.string().uuid(),
    machineId: z.string().uuid().optional(),
    /** Required when no machine is picked (e.g. "Generator"). With a machineId the server uses the machine's own name. */
    machineName: z.string().trim().min(1).max(100).optional(),
    faultTypes: z.array(z.string().trim().min(1).max(64)).min(1).max(10),
    description: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.machineId || v.machineName, { message: "Pick a machine or give a machine name", path: ["machineName"] });

export const ticketListQuery = z.object({
  status: z.enum(["open", "fixed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const noticeListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ticketSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  machineId: z.string().uuid().nullable(),
  machineName: z.string(),
  displayName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  otherDetails: z.string().nullable(),
  faultTypes: z.array(z.string()),
  description: z.string().nullable(),
  status: z.enum(["open", "fixed"]),
  reportedAt: z.string(),
  reportedBy: z.string().nullable(),
  fixedAt: z.string().nullable(),
});

export const noticeSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  priority: z.enum(["info", "notice", "urgent"]),
  expiresAt: z.string(),
  createdAt: z.string(),
});
