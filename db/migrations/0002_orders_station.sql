CREATE TYPE "public"."order_type" AS ENUM('walk_in', 'online');--> statement-breakpoint
CREATE TABLE "branch_machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"display_name" varchar(100),
	"serial_number" varchar(100),
	"other_details" text,
	"wash_price_pesewas" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_machines_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "branch_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"code" varchar(64) NOT NULL,
	"description" text,
	"image_url" text,
	"price_pesewas" bigint NOT NULL,
	"extra_wash_price_pesewas" bigint,
	"extra_dry_price_pesewas" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"show_on_customer_side" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_services_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
ALTER TABLE "order_status_events" ALTER COLUMN "from_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "order_status_events" ALTER COLUMN "to_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'pending_dropoff'::text;--> statement-breakpoint
DROP TYPE "public"."order_status";--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_dropoff', 'checked_in', 'sorting', 'washing', 'drying', 'folding', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled');--> statement-breakpoint
ALTER TABLE "order_status_events" ALTER COLUMN "from_status" SET DATA TYPE "public"."order_status" USING "from_status"::"public"."order_status";--> statement-breakpoint
ALTER TABLE "order_status_events" ALTER COLUMN "to_status" SET DATA TYPE "public"."order_status" USING "to_status"::"public"."order_status";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'pending_dropoff'::"public"."order_status";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DATA TYPE "public"."order_status" USING "status"::"public"."order_status";--> statement-breakpoint
ALTER TABLE "order_status_events" ADD COLUMN "attendance_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_type" "order_type" DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "service_type" varchar(64) DEFAULT 'wash_and_dry' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "bag_number" varchar(16);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "item_count" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "estimated_loads" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "extra_wash_loads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "extra_dry_loads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "whites_separate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_delivery" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_phone" varchar(32);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_hall" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_room" varchar(50);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_method" "payment_method";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "base_price_pesewas" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "created_by_attendant_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "branch_machines" ADD CONSTRAINT "branch_machines_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_services" ADD CONSTRAINT "branch_services_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_branch_machines_branch" ON "branch_machines" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_branch_services_code_active" ON "branch_services" USING btree ("branch_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_machine_id_branch_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."branch_machines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_attendant_id_attendants_id_fk" FOREIGN KEY ("created_by_attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_orders_branch_placed" ON "orders" USING btree ("branch_id","placed_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_orders_active_bag" ON "orders" USING btree ("branch_id","bag_number") WHERE bag_number IS NOT NULL AND deleted_at IS NULL AND status NOT IN ('completed','cancelled','delivered');--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "order_number_seq" START WITH 1000;
