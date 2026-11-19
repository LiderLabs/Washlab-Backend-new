CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"name" varchar(100) NOT NULL,
	"code" varchar(64) NOT NULL,
	"description" text,
	"image_url" text,
	"base_price_pesewas" bigint NOT NULL,
	"pricing_type" varchar(32) DEFAULT 'per_load' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "delivery_fees" jsonb;--> statement-breakpoint
ALTER TABLE "attendants" ADD COLUMN "enrollment_token_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "attendants" ADD COLUMN "enrollment_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendants" ADD COLUMN "enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "status" varchar(32) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "status_note" varchar(255);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "status_changed_by" varchar(128);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_services_code_active" ON "services" USING btree ("code") WHERE deleted_at IS NULL;