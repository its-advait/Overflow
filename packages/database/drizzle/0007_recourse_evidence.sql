CREATE TABLE "complaints" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text NOT NULL,
	"escrow_address" text NOT NULL,
	"kind" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk" text NOT NULL,
	"cipher_proof" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plain_leaf" text NOT NULL,
	"plain_proof" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"derived_leaf" text,
	"revealed_key" text,
	"decrypted_row" text,
	"cipher_proof_verified" boolean DEFAULT false NOT NULL,
	"plain_proof_verified" boolean DEFAULT false NOT NULL,
	"cheat_verified" boolean DEFAULT false NOT NULL,
	"detail" text NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "complaints_purchase_id_unique" UNIQUE("purchase_id")
);
--> statement-breakpoint
ALTER TABLE "escrow_orders" ADD COLUMN "chunk_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "escrow_orders" ADD COLUMN "challenge_end" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "randomness" text;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "judge" text DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "rows" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "complaints_escrow_idx" ON "complaints" USING btree ("escrow_address");