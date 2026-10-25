CREATE TABLE "reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"block_number" numeric(78, 0) NOT NULL,
	"treasury_chain" numeric(78, 0) NOT NULL,
	"treasury_ledger" numeric(78, 0) NOT NULL,
	"treasury_difference" numeric(78, 0) NOT NULL,
	"escrows_checked" integer NOT NULL,
	"events_checked" integer NOT NULL,
	"differences" jsonb NOT NULL,
	"exception_ids" text[] NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exceptions" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD COLUMN "event_key" text NOT NULL;--> statement-breakpoint
CREATE INDEX "reconciliation_runs_ran_at_idx" ON "reconciliation_runs" USING btree ("ran_at");--> statement-breakpoint
CREATE INDEX "exceptions_subject_idx" ON "exceptions" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "financial_entries_event_key_idx" ON "financial_entries" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "financial_entries_tx_hash_idx" ON "financial_entries" USING btree ("tx_hash");