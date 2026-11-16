import { z } from "zod";

const pin = z.string().min(4).max(32);

export const stationLoginSchema = z.object({
  branchId: z.string().uuid(),
  deviceId: z.string().min(1).max(128),
  stationPin: pin,
  deviceInfo: z.string().max(255).optional(),
});

export const stationLoginResponseSchema = z.object({
  stationToken: z.string(),
  sessionId: z.string().uuid(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  expiresAt: z.string(),
});

export const stationSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  deviceId: z.string(),
  expiresAt: z.string(),
});

export const stationAttendantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  isHomeBranch: z.boolean(),
  activeAttendance: z
    .object({
      id: z.string().uuid(),
      branchId: z.string().uuid(),
      branchName: z.string(),
      clockInAt: z.string(),
    })
    .nullable(),
});

export const activeAttendanceSchema = z.object({
  attendanceId: z.string().uuid(),
  attendantId: z.string().uuid(),
  attendantName: z.string(),
  clockInAt: z.string(),
});

export const clockInSchema = z.object({
  attendantId: z.string().uuid(),
  pin,
});

export const clockOutSchema = z.object({
  attendanceId: z.string().uuid(),
  pin,
});

export const attendanceResultSchema = z.object({
  success: z.boolean(),
  attendant: z.object({ name: z.string() }),
  attendanceId: z.string().uuid(),
});

export type StationLoginInput = z.infer<typeof stationLoginSchema>;
export type ClockInInput = z.infer<typeof clockInSchema>;
export type ClockOutInput = z.infer<typeof clockOutSchema>;
