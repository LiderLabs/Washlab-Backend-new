ALTER TABLE "cash_credits" ADD COLUMN "legacy_convex_id" varchar(64);--> statement-breakpoint
ALTER TABLE "cash_ledger" ADD COLUMN "legacy_convex_id" varchar(64);--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD COLUMN "legacy_convex_id" varchar(64);--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "voucher_usages" ADD COLUMN "legacy_convex_id" varchar(64);--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "legacy_convex_id" varchar(64);--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "applicable_branches" uuid[];--> statement-breakpoint
ALTER TABLE "cash_credits" ADD CONSTRAINT "cash_credits_legacy_convex_id_unique" UNIQUE("legacy_convex_id");--> statement-breakpoint
ALTER TABLE "cash_ledger" ADD CONSTRAINT "cash_ledger_legacy_convex_id_unique" UNIQUE("legacy_convex_id");--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_legacy_convex_id_unique" UNIQUE("legacy_convex_id");--> statement-breakpoint
ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usages_legacy_convex_id_unique" UNIQUE("legacy_convex_id");--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_legacy_convex_id_unique" UNIQUE("legacy_convex_id");