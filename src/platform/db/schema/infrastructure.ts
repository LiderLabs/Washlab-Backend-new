import { pgTable, uuid, varchar, integer, numeric, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"), // 'pending', 'processing', 'completed', 'failed'
    retryCount: integer("retry_count").notNull().default(0),
    lastError: varchar("last_error", { length: 1000 }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_outbox_unprocessed").on(table.scheduledFor).where(sql`status IN ('pending', 'processing')`),
  ]
);

export const systemSettings = pgTable("system_settings", {
  id: integer("id").primaryKey().default(1), // Singleton row
  taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  pointsPerGhs: integer("points_per_ghs").notNull().default(1),
  minRedemptionPoints: integer("min_redemption_points").notNull().default(100),
  autoLogoutMinutes: integer("auto_logout_minutes").notNull().default(30),
  updatedBy: varchar("updated_by", { length: 128 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: varchar("entity_id", { length: 64 }).notNull(),
    performedByUserId: varchar("performed_by_user_id", { length: 128 }).notNull(),
    performedByRole: varchar("performed_by_role", { length: 32 }).notNull(),
    changes: jsonb("changes"), // Explicit allowlisted diff
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: varchar("user_agent", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_audit_logs_entity").on(table.entityType, table.entityId, table.createdAt),
    index("idx_audit_logs_actor").on(table.performedByUserId, table.createdAt),
  ]
);
