ALTER TABLE "vouchers" ADD COLUMN "max_uses_per_customer" integer;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "applicable_services" jsonb;