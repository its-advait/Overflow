CREATE TABLE "indexer_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"last_block" numeric(78, 0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chain_transactions_block_idx" ON "chain_transactions" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "chain_transactions_event_idx" ON "chain_transactions" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "purchases_order_id_idx" ON "purchases" USING btree ("order_id_bytes32");--> statement-breakpoint
CREATE INDEX "purchases_escrow_address_idx" ON "purchases" USING btree ("escrow_address");