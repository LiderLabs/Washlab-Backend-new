CREATE TYPE "public"."notice_priority" AS ENUM('info', 'notice', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."maintenance_ticket_status" AS ENUM('open', 'fixed');--> statement-breakpoint
CREATE TABLE "headlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid,
	"title" varchar(255) NOT NULL,
	"body" text,
	"priority" "notice_priority" DEFAULT 'info' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_admin_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "headlines_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "maintenance_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"machine_id" uuid,
	"machine_name" varchar(100) NOT NULL,
	"display_name" varchar(100),
	"serial_number" varchar(100),
	"other_details" text,
	"fault_types" text[] NOT NULL,
	"description" text,
	"status" "maintenance_ticket_status" DEFAULT 'open' NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_by_attendant_id" uuid,
	"reported_by_name" varchar(255),
	"fixed_at" timestamp with time zone,
	"fixed_by_admin_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_tickets_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
ALTER TABLE "headlines" ADD CONSTRAINT "headlines_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headlines" ADD CONSTRAINT "headlines_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_machine_id_branch_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."branch_machines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_reported_by_attendant_id_attendants_id_fk" FOREIGN KEY ("reported_by_attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_fixed_by_admin_id_admins_id_fk" FOREIGN KEY ("fixed_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_headlines_expires" ON "headlines" USING btree ("expires_at") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_tickets_branch_status" ON "maintenance_tickets" USING btree ("branch_id","status","reported_at" DESC NULLS LAST) WHERE deleted_at IS NULL;