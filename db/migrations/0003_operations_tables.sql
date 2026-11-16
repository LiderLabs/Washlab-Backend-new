CREATE TYPE "public"."inventory_category" AS ENUM('cleaning_supplies', 'add_ons', 'facility', 'retail', 'operational', 'washing_supplies');--> statement-breakpoint
CREATE TYPE "public"."inventory_status" AS ENUM('critical', 'low', 'ok', 'ordered');--> statement-breakpoint
CREATE TYPE "public"."notification_recipient" AS ENUM('customer', 'attendant', 'admin', 'station', 'all');--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"category" "inventory_category" NOT NULL,
	"unit" varchar(32) NOT NULL,
	"description" text,
	"current_stock" integer DEFAULT 0 NOT NULL,
	"max_stock" integer DEFAULT 0 NOT NULL,
	"min_stock" integer DEFAULT 0 NOT NULL,
	"reorder_point" integer DEFAULT 0 NOT NULL,
	"status" "inventory_status" DEFAULT 'ok' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"recipient_type" "notification_recipient" NOT NULL,
	"recipient_id" varchar(64),
	"branch_id" uuid,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"type" varchar(16) DEFAULT 'info' NOT NULL,
	"priority" varchar(16) DEFAULT 'normal' NOT NULL,
	"entity_type" varchar(32),
	"entity_id" varchar(64),
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_branch" ON "inventory_items" USING btree ("branch_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient" ON "notifications" USING btree ("recipient_type","recipient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notifications_branch" ON "notifications" USING btree ("branch_id","created_at" DESC NULLS LAST);