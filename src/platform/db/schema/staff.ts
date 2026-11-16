import { pgTable, uuid, varchar, integer, timestamp, uniqueIndex, index, pgEnum, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branches } from "./branches.js";

export const staffStatusEnum = pgEnum("staff_status", [
  "invited",
  "active",
  "suspended",
  "locked",
]);

export const userRoleEnum = pgEnum("user_role", [
  "super_admin",
  "admin",
  "attendant",
  "driver",
  "customer",
]);

export const attendants = pgTable(
  "attendants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    clerkUserId: varchar("clerk_user_id", { length: 128 }),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phoneNumber: varchar("phone_number", { length: 32 }).notNull(),
    passcodeHash: varchar("passcode_hash", { length: 255 }), // Argon2id, or "legacy-sha256$<salt>$<hash>" until first login
    status: staffStatusEnum("status").notNull().default("invited"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_attendants_email_active").on(table.email).where(sql`deleted_at IS NULL`),
    uniqueIndex("idx_attendants_clerk_active").on(table.clerkUserId).where(sql`deleted_at IS NULL AND clerk_user_id IS NOT NULL`),
  ]
);

export const admins = pgTable(
  "admins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    clerkUserId: varchar("clerk_user_id", { length: 128 }).notNull(),
    role: userRoleEnum("role").notNull().default("admin"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_admins_email_active").on(table.email).where(sql`deleted_at IS NULL`),
    uniqueIndex("idx_admins_clerk_active").on(table.clerkUserId).where(sql`deleted_at IS NULL`),
  ]
);

/** Extra branches an attendant can work at, besides their home branch (attendants.branch_id). */
export const attendantBranches = pgTable(
  "attendant_branches",
  {
    attendantId: uuid("attendant_id").notNull().references(() => attendants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.attendantId, table.branchId] }),
    index("idx_attendant_branches_branch").on(table.branchId),
  ]
);

/** One row per station login (a shared device at a branch). Token is stored as a SHA-256 hash. */
export const stationSessions = pgTable(
  "station_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    deviceId: varchar("device_id", { length: 128 }).notNull(),
    attendantId: uuid("attendant_id").references(() => attendants.id, { onDelete: "set null" }),
    sessionTokenHash: varchar("session_token_hash", { length: 255 }).notNull().unique(),
    deviceInfo: varchar("device_info", { length: 255 }),
    ipAddress: varchar("ip_address", { length: 45 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one live session per branch + device; logging in again replaces it.
    uniqueIndex("idx_station_sessions_active_device")
      .on(table.branchId, table.deviceId)
      .where(sql`revoked_at IS NULL`),
  ]
);

/** Clock-in / clock-out (PIN only). An open row has clock_out_at NULL. */
export const attendanceLogs = pgTable(
  "attendance_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    attendantId: uuid("attendant_id").notNull().references(() => attendants.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    clockInAt: timestamp("clock_in_at", { withTimezone: true }).notNull().defaultNow(),
    clockOutAt: timestamp("clock_out_at", { withTimezone: true }),
    deviceId: varchar("device_id", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // An attendant can only be clocked in at one place at a time.
    uniqueIndex("idx_attendance_one_open").on(table.attendantId).where(sql`clock_out_at IS NULL`),
    index("idx_attendance_branch_open").on(table.branchId).where(sql`clock_out_at IS NULL`),
    index("idx_attendance_branch_time").on(table.branchId, table.clockInAt),
  ]
);

export type Attendant = typeof attendants.$inferSelect;
export type AttendanceLog = typeof attendanceLogs.$inferSelect;
