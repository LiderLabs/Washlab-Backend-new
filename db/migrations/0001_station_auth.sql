CREATE TABLE "attendance_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_convex_id" varchar(64),
	"attendant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"clock_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_out_at" timestamp with time zone,
	"device_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_logs_legacy_convex_id_unique" UNIQUE("legacy_convex_id")
);
--> statement-breakpoint
CREATE TABLE "attendant_branches" (
	"attendant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendant_branches_attendant_id_branch_id_pk" PRIMARY KEY("attendant_id","branch_id")
);
--> statement-breakpoint
ALTER TABLE "attendants" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "attendants" ALTER COLUMN "status" SET DEFAULT 'invited'::text;--> statement-breakpoint
DROP TYPE "public"."staff_status";--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('invited', 'active', 'suspended', 'locked');--> statement-breakpoint
ALTER TABLE "attendants" ALTER COLUMN "status" SET DEFAULT 'invited'::"public"."staff_status";--> statement-breakpoint
ALTER TABLE "attendants" ALTER COLUMN "status" SET DATA TYPE "public"."staff_status" USING "status"::"public"."staff_status";--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "station_pin_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "station_pin_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "station_sessions" ADD COLUMN "device_id" varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE "station_sessions" ADD COLUMN "ip_address" varchar(45);--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendant_branches" ADD CONSTRAINT "attendant_branches_attendant_id_attendants_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."attendants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendant_branches" ADD CONSTRAINT "attendant_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_attendance_one_open" ON "attendance_logs" USING btree ("attendant_id") WHERE clock_out_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_attendance_branch_open" ON "attendance_logs" USING btree ("branch_id") WHERE clock_out_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_attendance_branch_time" ON "attendance_logs" USING btree ("branch_id","clock_in_at");--> statement-breakpoint
CREATE INDEX "idx_attendant_branches_branch" ON "attendant_branches" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_station_sessions_active_device" ON "station_sessions" USING btree ("branch_id","device_id") WHERE revoked_at IS NULL;--> statement-breakpoint
ALTER TABLE "attendants" DROP COLUMN "biometric_template_hash";--> statement-breakpoint
ALTER TABLE "attendants" DROP COLUMN "biometric_data_encrypted";--> statement-breakpoint
ALTER TABLE "attendants" DROP COLUMN "enrolled_at";