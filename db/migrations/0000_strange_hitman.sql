CREATE TYPE "public"."staff_status" AS ENUM('invited', 'enrolling', 'active', 'suspended', 'locked');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('super_admin', 'admin', 'attendant', 'driver', 'customer');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'pending_dropoff', 'received', 'weighed', 'washing', 'drying', 'folding', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'successful', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'mobile_money', 'card', 'voucher');--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"name" varchar(255) NOT NULL,
	"code" varchar(32) NOT NULL,
	"terminal_id" varchar(16),
	"phone_number" varchar(32) NOT NULL,
	"email" varchar(255),
	"address" text NOT NULL,
	"city" varchar(100) NOT NULL,
	"pricing_per_kg_pesewas" bigint NOT NULL,
	"delivery_fee_pesewas" bigint DEFAULT 0 NOT NULL,
	"station_pin_hash" varchar(255),
	"require_station_login" boolean DEFAULT true NOT NULL,
	"weekly_order_target" integer DEFAULT 0,
	"momo_number" varchar(32),
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"clerk_user_id" varchar(128) NOT NULL,
	"role" "user_role" DEFAULT 'admin' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "attendants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"clerk_user_id" varchar(128),
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone_number" varchar(32) NOT NULL,
	"passcode_hash" varchar(255),
	"status" "staff_status" DEFAULT 'invited' NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"biometric_template_hash" varchar(255),
	"biometric_data_encrypted" jsonb,
	"enrolled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendants_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "station_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"attendant_id" uuid,
	"session_token_hash" varchar(255) NOT NULL,
	"device_info" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"clerk_user_id" varchar(128),
	"name" varchar(255) NOT NULL,
	"phone_number" varchar(32) NOT NULL,
	"email" varchar(255),
	"branch_id" uuid,
	"is_verified" boolean DEFAULT false NOT NULL,
	"anonymized_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "order_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"changed_by_user_id" varchar(128) NOT NULL,
	"changed_by_role" "user_role" NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"order_number" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"weight_kg" numeric(6, 2),
	"service_price_pesewas" bigint DEFAULT 0 NOT NULL,
	"delivery_fee_pesewas" bigint DEFAULT 0 NOT NULL,
	"discount_pesewas" bigint DEFAULT 0 NOT NULL,
	"final_price_pesewas" bigint DEFAULT 0 NOT NULL,
	"payment_status" "payment_status" DEFAULT 'pending' NOT NULL,
	"fulfilled_by_attendant_id" uuid,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "cash_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"attendant_id" uuid NOT NULL,
	"expected_amount_pesewas" bigint NOT NULL,
	"actual_amount_pesewas" bigint NOT NULL,
	"discrepancy_pesewas" bigint DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'submitted' NOT NULL,
	"verified_by_admin_id" uuid,
	"verified_at" timestamp with time zone,
	"notes" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_reconciliations_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"order_id" uuid,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'GHS' NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"gateway_reference" varchar(128),
	"idempotency_key" varchar(128),
	"metadata" jsonb,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_legacy_convex_id_unique" UNIQUE("legacy_convex_id"),
	CONSTRAINT "payments_gateway_reference_unique" UNIQUE("gateway_reference"),
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"event_id" varchar(128) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"error_message" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"points_delta" integer NOT NULL,
	"reason" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voucher_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"discount_applied_pesewas" bigint NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"discount_type" varchar(16) NOT NULL,
	"discount_value" bigint NOT NULL,
	"min_order_amount_pesewas" bigint DEFAULT 0 NOT NULL,
	"max_usage_count" integer DEFAULT 1,
	"current_usage_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" varchar(64) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" varchar(64) NOT NULL,
	"performed_by_user_id" varchar(128) NOT NULL,
	"performed_by_role" varchar(32) NOT NULL,
	"changes" jsonb,
	"ip_address" varchar(45),
	"user_agent" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"aggregate_id" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(1000),
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"tax_rate_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"points_per_ghs" integer DEFAULT 1 NOT NULL,
	"min_redemption_points" integer DEFAULT 100 NOT NULL,
	"auto_logout_minutes" integer DEFAULT 30 NOT NULL,
	"updated_by" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendants" ADD CONSTRAINT "attendants_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_sessions" ADD CONSTRAINT "station_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_sessions" ADD CONSTRAINT "station_sessions_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfilled_by_attendant_id_attendants_id_fk" FOREIGN KEY ("fulfilled_by_attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_branches_code_active" ON "branches" USING btree ("code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_branches_terminal_active" ON "branches" USING btree ("terminal_id") WHERE deleted_at IS NULL AND terminal_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_admins_email_active" ON "admins" USING btree ("email") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_admins_clerk_active" ON "admins" USING btree ("clerk_user_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_attendants_email_active" ON "attendants" USING btree ("email") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_attendants_clerk_active" ON "attendants" USING btree ("clerk_user_id") WHERE deleted_at IS NULL AND clerk_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_customers_phone_active" ON "customers" USING btree ("phone_number") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_customers_clerk_active" ON "customers" USING btree ("clerk_user_id") WHERE deleted_at IS NULL AND clerk_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_order_status_events_order" ON "order_status_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_orders_order_number" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "idx_orders_branch_status" ON "orders" USING btree ("branch_id","status") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_orders_customer_date" ON "orders" USING btree ("customer_id","placed_at");--> statement-breakpoint
CREATE INDEX "idx_cash_reconciliation_branch" ON "cash_reconciliations" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_payments_branch_date" ON "payments" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_payments_reconciliation" ON "payments" USING btree ("status","created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_event" ON "webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_order_loyalty_award" ON "loyalty_ledger" USING btree ("order_id","reason") WHERE order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_loyalty_customer" ON "loyalty_ledger" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_voucher_order" ON "voucher_usages" USING btree ("voucher_id","order_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_entity" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor" ON "audit_logs" USING btree ("performed_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_unprocessed" ON "outbox_messages" USING btree ("scheduled_for") WHERE status IN ('pending', 'processing');