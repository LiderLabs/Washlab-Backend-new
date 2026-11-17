CREATE TYPE "public"."recon_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "cash_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"day" date NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"remaining_pesewas" bigint NOT NULL,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_cash_credit_bounds" CHECK (remaining_pesewas >= 0 AND remaining_pesewas <= amount_pesewas)
);
--> statement-breakpoint
CREATE TABLE "cash_deductions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"attendant_id" uuid,
	"amount_pesewas" bigint NOT NULL,
	"reason" varchar(500) NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "cash_deductions_legacy_convex_id_unique" UNIQUE("legacy_convex_id"),
	CONSTRAINT "chk_cash_deduction_positive" CHECK (amount_pesewas > 0)
);
--> statement-breakpoint
CREATE TABLE "cash_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"day" date NOT NULL,
	"collected" bigint DEFAULT 0 NOT NULL,
	"order_count" bigint DEFAULT 0 NOT NULL,
	"sent" bigint DEFAULT 0 NOT NULL,
	"deducted" bigint DEFAULT 0 NOT NULL,
	"credit_applied" bigint DEFAULT 0 NOT NULL,
	"outstanding" bigint GENERATED ALWAYS AS (GREATEST(0, collected - sent - deducted - credit_applied)) STORED NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_cash_ledger_nonneg" CHECK (collected >= 0 AND sent >= 0 AND deducted >= 0 AND credit_applied >= 0)
);
--> statement-breakpoint
CREATE TABLE "cash_recon_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"day" date NOT NULL,
	"amount_pesewas" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_recon_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"attendant_id" uuid,
	"paystack_reference" varchar(128) NOT NULL,
	"paystack_transaction_id" varchar(64),
	"amount_sent_pesewas" bigint NOT NULL,
	"sender_momo_number" varchar(32) NOT NULL,
	"network" varchar(16),
	"status" "recon_status" DEFAULT 'pending' NOT NULL,
	"excess_pesewas" bigint DEFAULT 0 NOT NULL,
	"display_text" text,
	"notes" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "cash_recon_transactions_legacy_convex_id_unique" UNIQUE("legacy_convex_id"),
	CONSTRAINT "cash_recon_transactions_paystack_reference_unique" UNIQUE("paystack_reference"),
	CONSTRAINT "chk_recon_amount_positive" CHECK (amount_sent_pesewas > 0)
);
--> statement-breakpoint
ALTER TABLE "cash_credits" ADD CONSTRAINT "cash_credits_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_credits" ADD CONSTRAINT "cash_credits_transaction_id_cash_recon_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."cash_recon_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_deductions" ADD CONSTRAINT "cash_deductions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_deductions" ADD CONSTRAINT "cash_deductions_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ledger" ADD CONSTRAINT "cash_ledger_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_recon_allocations" ADD CONSTRAINT "cash_recon_allocations_transaction_id_cash_recon_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."cash_recon_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_recon_allocations" ADD CONSTRAINT "cash_recon_allocations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_recon_transactions" ADD CONSTRAINT "cash_recon_transactions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_recon_transactions" ADD CONSTRAINT "cash_recon_transactions_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cash_credits_branch" ON "cash_credits" USING btree ("branch_id","day") WHERE remaining_pesewas > 0;--> statement-breakpoint
CREATE INDEX "idx_cash_deductions_branch_day" ON "cash_deductions" USING btree ("branch_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cash_ledger_branch_day" ON "cash_ledger" USING btree ("branch_id","day");--> statement-breakpoint
CREATE INDEX "idx_recon_alloc_tx" ON "cash_recon_allocations" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_recon_alloc_branch_day" ON "cash_recon_allocations" USING btree ("branch_id","day");--> statement-breakpoint
CREATE INDEX "idx_recon_branch_created" ON "cash_recon_transactions" USING btree ("branch_id","created_at" DESC NULLS LAST);