-- Prototype controller_requests rows (created before calldata was stored) cannot be backfilled: no treasury
-- address was known when they were written. No deployed database holds any; clear them before the NOT NULL columns.
DELETE FROM "controller_requests";--> statement-breakpoint
ALTER TABLE "controller_requests" ADD COLUMN "exception_id" text;--> statement-breakpoint
ALTER TABLE "controller_requests" ADD COLUMN "target" text NOT NULL;--> statement-breakpoint
ALTER TABLE "controller_requests" ADD COLUMN "data" text NOT NULL;--> statement-breakpoint
ALTER TABLE "controller_requests" ADD COLUMN "value" numeric(78, 0) NOT NULL;--> statement-breakpoint
ALTER TABLE "controller_requests" ADD COLUMN "summary" text NOT NULL;--> statement-breakpoint
ALTER TABLE "exceptions" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "exceptions" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "exceptions" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "exceptions" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "controller_requests" ADD CONSTRAINT "controller_requests_exception_id_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "controller_requests_status_idx" ON "controller_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "controller_requests_exception_idx" ON "controller_requests" USING btree ("exception_id");--> statement-breakpoint
ALTER TABLE "controller_requests" ADD CONSTRAINT "controller_requests_value_nonneg" CHECK ("controller_requests"."value" >= 0);