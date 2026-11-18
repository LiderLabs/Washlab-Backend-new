CREATE TABLE "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"points_delta" integer NOT NULL,
	"balance_after" integer DEFAULT 0 NOT NULL,
	"reason" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voucher_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"customer_id" uuid,
	"order_id" uuid NOT NULL,
	"discount_applied_pesewas" bigint NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(100),
	"branch_id" uuid,
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
DROP TABLE "loyalty_ledgers" CASCADE;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_order_loyalty_award" ON "loyalty_ledger" USING btree ("order_id","reason") WHERE order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_loyalty_customer" ON "loyalty_ledger" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_voucher_order" ON "voucher_usages" USING btree ("voucher_id","order_id");--> statement-breakpoint
DROP TYPE "public"."loyalty_tx_type";