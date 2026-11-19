ALTER TABLE "vouchers" ADD COLUMN "batch_id" varchar(64);--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "deleted_at" timestamp with time zone;