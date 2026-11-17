CREATE TYPE "public"."loyalty_tx_type" AS ENUM('earned', 'redeemed', 'adjusted');--> statement-breakpoint
CREATE TABLE "loyalty_ledgers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"type" "loyalty_tx_type" NOT NULL,
	"points" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"description" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "loyalty_ledger" CASCADE;--> statement-breakpoint
DROP TABLE "voucher_usages" CASCADE;--> statement-breakpoint
DROP TABLE "vouchers" CASCADE;