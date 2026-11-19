import { pgTable, uuid, varchar, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branches } from "./branches.js";
import { branchMachines } from "./catalog.js";
import { admins, attendants } from "./staff.js";

export const ticketStatusEnum = pgEnum("maintenance_ticket_status", ["open", "fixed"]);
export const noticePriorityEnum = pgEnum("notice_priority", ["info", "notice", "urgent"]);

/** Machine faults reported from the station. Machine details are copied at report time so history survives renames. */
export const maintenanceTickets = pgTable(
  "maintenance_tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    machineId: uuid("machine_id").references(() => branchMachines.id, { onDelete: "set null" }),
    machineName: varchar("machine_name", { length: 100 }).notNull(),
    displayName: varchar("display_name", { length: 100 }),
    serialNumber: varchar("serial_number", { length: 100 }),
    otherDetails: text("other_details"),
    faultTypes: text("fault_types").array().notNull(),
    description: text("description"),
    status: ticketStatusEnum("status").notNull().default("open"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    reportedByAttendantId: uuid("reported_by_attendant_id").references(() => attendants.id, { onDelete: "set null" }),
    /** Free-text name from the Convex data, kept for imported tickets that have no attendant row. */
    reportedByName: varchar("reported_by_name", { length: 255 }),
    fixedAt: timestamp("fixed_at", { withTimezone: true }),
    fixedByAdminId: uuid("fixed_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_tickets_branch_status").on(table.branchId, table.status, table.reportedAt.desc()).where(sql`deleted_at IS NULL`),
  ]
);

/** Notices admins post for staff, to one branch or (branch_id null) to all of them. Hidden once expired. */
export const headlines = pgTable(
  "headlines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    priority: noticePriorityEnum("priority").notNull().default("info"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdByAdminId: uuid("created_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_headlines_expires").on(table.expiresAt).where(sql`deleted_at IS NULL`)]
);
