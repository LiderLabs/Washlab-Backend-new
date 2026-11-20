CREATE TYPE "public"."subscription_otp_status" AS ENUM('pending', 'used', 'expired', 'locked');--> statement-breakpoint
CREATE TYPE "public"."subscription_source" AS ENUM('online', 'admin_grant');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('pending_payment', 'active', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'subscription';--> statement-breakpoint
CREATE TABLE "customer_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"customer_id" uuid,
	"phone_number" varchar(32) NOT NULL,
	"customer_name" varchar(255) NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_name" varchar(255) NOT NULL,
	"plan_price_pesewas" bigint NOT NULL,
	"loads_total" integer NOT NULL,
	"loads_used" integer DEFAULT 0 NOT NULL,
	"validity_days" integer NOT NULL,
	"applicable_service_types" varchar(64)[],
	"applicable_branches" uuid[],
	"purchase_branch_id" uuid,
	"code" varchar(16) NOT NULL,
	"status" "subscription_status" DEFAULT 'pending_payment' NOT NULL,
	"source" "subscription_source" DEFAULT 'online' NOT NULL,
	"payment_reference" varchar(128),
	"note" text,
	"email" varchar(255),
	"paid_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customer_subscriptions_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"phone_number" varchar(32) NOT NULL,
	"branch_id" uuid NOT NULL,
	"requested_by_attendant_id" uuid,
	"code_hash" varchar(255) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" "subscription_otp_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"name" varchar(255) NOT NULL,
	"description" text,
	"price_pesewas" bigint NOT NULL,
	"loads_included" integer NOT NULL,
	"validity_days" integer NOT NULL,
	"applicable_branches" uuid[],
	"applicable_service_types" varchar(64)[],
	"template" varchar(64),
	"headline" varchar(255),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "subscription_plans_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"subscription_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"attendant_id" uuid,
	"loads_used" integer NOT NULL,
	"extra_wash" integer DEFAULT 0 NOT NULL,
	"extra_dry" integer DEFAULT 0 NOT NULL,
	"loads_remaining_after" integer NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "subscription_usages_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subscription_loads_used" integer;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "customer_subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "customer_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "customer_subscriptions_purchase_branch_id_branches_id_fk" FOREIGN KEY ("purchase_branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_otps" ADD CONSTRAINT "subscription_otps_subscription_id_customer_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."customer_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_otps" ADD CONSTRAINT "subscription_otps_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_otps" ADD CONSTRAINT "subscription_otps_requested_by_attendant_id_attendants_id_fk" FOREIGN KEY ("requested_by_attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usages" ADD CONSTRAINT "subscription_usages_subscription_id_customer_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."customer_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usages" ADD CONSTRAINT "subscription_usages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usages" ADD CONSTRAINT "subscription_usages_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usages" ADD CONSTRAINT "subscription_usages_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_customer_subscriptions_code" ON "customer_subscriptions" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_customer_subscriptions_payment_reference" ON "customer_subscriptions" USING btree ("payment_reference");--> statement-breakpoint
CREATE INDEX "idx_customer_subscriptions_customer" ON "customer_subscriptions" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_customer_subscriptions_phone" ON "customer_subscriptions" USING btree ("phone_number","created_at");--> statement-breakpoint
CREATE INDEX "idx_customer_subscriptions_plan" ON "customer_subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_customer_subscriptions_status" ON "customer_subscriptions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_subscription_otps_subscription_status" ON "subscription_otps" USING btree ("subscription_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_subscription_otps_created_at" ON "subscription_otps" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_subscription_plans_active_order" ON "subscription_plans" USING btree ("is_active","sort_order","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscription_usages_live_order" ON "subscription_usages" USING btree ("order_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_subscription_usages_subscription" ON "subscription_usages" USING btree ("subscription_id","used_at");--> statement-breakpoint
CREATE INDEX "idx_subscription_usages_branch" ON "subscription_usages" USING btree ("branch_id","used_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_subscription_id_customer_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."customer_subscriptions"("id") ON DELETE set null ON UPDATE no action;