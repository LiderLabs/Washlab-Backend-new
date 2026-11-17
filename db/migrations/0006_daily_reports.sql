CREATE TYPE "public"."daily_report_status" AS ENUM('draft', 'submitted', 'submitted_with_outstanding');--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"branch_id" uuid NOT NULL,
	"attendant_id" uuid,
	"report_date" date NOT NULL,
	"attendants_on_shift" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"washer_tokens_used" integer DEFAULT 0 NOT NULL,
	"dryer_tokens_used" integer DEFAULT 0 NOT NULL,
	"total_tokens_used" integer DEFAULT 0 NOT NULL,
	"service_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"voucher_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cash_pesewas" bigint DEFAULT 0 NOT NULL,
	"mobile_money_pesewas" bigint DEFAULT 0 NOT NULL,
	"card_pesewas" bigint DEFAULT 0 NOT NULL,
	"total_revenue_pesewas" bigint DEFAULT 0 NOT NULL,
	"soap_units_used" integer DEFAULT 0 NOT NULL,
	"free_wash_count" integer DEFAULT 0 NOT NULL,
	"washing_plan_count" integer DEFAULT 0 NOT NULL,
	"technical_fault_count" integer DEFAULT 0 NOT NULL,
	"technical_fault_notes" text,
	"outstanding_amount_pesewas" bigint DEFAULT 0 NOT NULL,
	"outstanding_order_count" integer DEFAULT 0 NOT NULL,
	"outstanding_recovered_pesewas" bigint DEFAULT 0 NOT NULL,
	"status" "daily_report_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_reports_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_daily_reports_branch_date" ON "daily_reports" USING btree ("branch_id","report_date");--> statement-breakpoint
CREATE INDEX "idx_daily_reports_date" ON "daily_reports" USING btree ("report_date");