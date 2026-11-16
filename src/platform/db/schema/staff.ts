import { pgTable, uuid, varchar, integer, timestamp, uniqueIndex, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branches } from "./branches.js";

export const staffStatusEnum = pgEnum("staff_status", [
  "invited",
  "enrolling",
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
    passcodeHash: varchar("passcode_hash", { length: 255 }), // Argon2id hash
    status: staffStatusEnum("status").notNull().default("invited"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    biometricTemplateHash: varchar("biometric_template_hash", { length: 255 }),
    biometricDataEncrypted: jsonb("biometric_data_encrypted"), // AES-256-GCM { encryptedData, iv, authTag }
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
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

export const stationSessions = pgTable("station_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  attendantId: uuid("attendant_id").references(() => attendants.id, { onDelete: "set null" }),
  sessionTokenHash: varchar("session_token_hash", { length: 255 }).notNull().unique(),
  deviceInfo: varchar("device_info", { length: 255 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
