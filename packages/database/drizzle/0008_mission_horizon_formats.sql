ALTER TABLE "missions" ADD COLUMN "horizon" jsonb;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "allowed_formats" text[] DEFAULT '{"csv","json","parquet"}' NOT NULL;