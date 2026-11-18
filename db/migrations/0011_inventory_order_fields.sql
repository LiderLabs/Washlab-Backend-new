ALTER TABLE "inventory_items" ADD COLUMN "ordered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "order_quantity" integer;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "expected_arrival_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "arrival_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "last_restocked_at" timestamp with time zone;