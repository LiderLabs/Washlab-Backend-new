ALTER TABLE "cash_reconciliations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "cash_reconciliations" CASCADE;--> statement-breakpoint
-- "successful" is called "paid" in the original API; renaming the value keeps existing rows and indexes intact.
ALTER TYPE "public"."payment_status" RENAME VALUE 'successful' TO 'paid';--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "credit_auto_apply_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gateway_transaction_id" varchar(64);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "processed_by_attendant_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_processed_by_attendant_id_attendants_id_fk" FOREIGN KEY ("processed_by_attendant_id") REFERENCES "public"."attendants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_payments_order" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_payments_branch_paid" ON "payments" USING btree ("branch_id","paid_at") WHERE status = 'paid';--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "chk_gateway_payment_has_reference" CHECK (method NOT IN ('mobile_money','card') OR status <> 'paid' OR gateway_reference IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "chk_payment_amount_positive" CHECK (amount_pesewas >= 0);