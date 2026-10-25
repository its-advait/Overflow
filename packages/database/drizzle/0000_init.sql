CREATE TYPE "public"."escrow_status" AS ENUM('Created', 'Funded', 'Revealed', 'Settled', 'Refunded');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('PROPOSED', 'RESERVED', 'PAYMENT_PENDING', 'ESCROW_FUNDED', 'DELIVERY_PENDING', 'SETTLED', 'REFUNDED', 'REJECTED', 'PAYMENT_UNKNOWN', 'FAILED_BEFORE_FUNDING', 'RELEASED');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"purchase_id" text,
	"mission_id" text,
	"agent_id" text,
	"decoded_revert" text,
	"tx_hash" text,
	"simulated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"department" text NOT NULL,
	"role" text NOT NULL,
	"node_id" integer,
	"key" text NOT NULL,
	"parent_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"department" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	CONSTRAINT "allocations_amount_nonneg" CHECK ("allocations"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chain_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" numeric(78, 0) NOT NULL,
	"contract_address" text NOT NULL,
	"event_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "chain_transactions_tx_hash_log_index_unique" UNIQUE("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "controller_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"action" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "escrow_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text NOT NULL,
	"order_id_bytes32" text NOT NULL,
	"escrow_address" text NOT NULL,
	"seller_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"bond" numeric(78, 0) NOT NULL,
	"terms_hash" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"root_plain" text NOT NULL,
	"root_cipher" text NOT NULL,
	"key_commitment" text NOT NULL,
	"reveal_deadline" numeric(78, 0) NOT NULL,
	"challenge_window" numeric(78, 0) NOT NULL,
	"source_key" text NOT NULL,
	"min_timestamp" numeric(78, 0) NOT NULL,
	"status" "escrow_status" NOT NULL,
	"revealed_key" text,
	"refund_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escrow_orders_purchase_id_unique" UNIQUE("purchase_id"),
	CONSTRAINT "escrow_orders_escrow_address_unique" UNIQUE("escrow_address"),
	CONSTRAINT "escrow_orders_amount_nonneg" CHECK ("escrow_orders"."amount" >= 0),
	CONSTRAINT "escrow_orders_bond_nonneg" CHECK ("escrow_orders"."bond" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"reason" text NOT NULL,
	"amount" numeric(78, 0),
	"status" text NOT NULL,
	"purchase_id" text,
	"resolved_by" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "exceptions_amount_nonneg" CHECK ("exceptions"."amount" IS NULL OR "exceptions"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "financial_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text,
	"debit_account" text NOT NULL,
	"credit_account" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"memo" text NOT NULL,
	"source_event_id" text NOT NULL,
	"department" text,
	"tx_hash" text,
	"corrects_entry_id" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_entries_source_event_id_unique" UNIQUE("source_event_id"),
	CONSTRAINT "financial_entries_amount_nonneg" CHECK ("financial_entries"."amount" >= 0),
	CONSTRAINT "financial_entries_accounts_differ" CHECK ("financial_entries"."debit_account" <> "financial_entries"."credit_account")
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"goal" text NOT NULL,
	"budget" numeric(78, 0) NOT NULL,
	"root_node_id" integer NOT NULL,
	"owner_agent_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missions_budget_nonneg" CHECK ("missions"."budget" >= 0)
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"departments" text[] NOT NULL,
	"treasury_address" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"paying_node_id" integer NOT NULL,
	"request_ids" text[] NOT NULL,
	"merge_reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id_bytes32" text NOT NULL,
	"mission_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"purchase_group_id" text,
	"buyer_treasury" text NOT NULL,
	"seller_address" text NOT NULL,
	"escrow_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"paying_node_id" integer NOT NULL,
	"participating_agent_ids" text[] NOT NULL,
	"resource_manifest_hash" text NOT NULL,
	"terms_hash" text NOT NULL,
	"payment_path" text NOT NULL,
	"authorization_digest" text,
	"tx_hashes" text[] NOT NULL,
	"oracle_reason" text,
	"status" "purchase_status" NOT NULL,
	"authorization_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "purchases_amount_nonneg" CHECK ("purchases"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"purchase_id" text,
	"node_id" integer NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	"valid_before" numeric(78, 0) NOT NULL,
	"nonce" text NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_digest_unique" UNIQUE("digest"),
	CONSTRAINT "reservations_value_nonneg" CHECK ("reservations"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "resource_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"topic" text NOT NULL,
	"regions" text[] NOT NULL,
	"date_range" jsonb NOT NULL,
	"granularity" text NOT NULL,
	"required_fields" text[] NOT NULL,
	"format" text[] NOT NULL,
	"license" text NOT NULL,
	"freshness" jsonb NOT NULL,
	"max_price" numeric(78, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_requests_max_price_nonneg" CHECK ("resource_requests"."max_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"seller_id" text NOT NULL,
	"product_id" text NOT NULL,
	"coverage" jsonb NOT NULL,
	"license" text NOT NULL,
	"price" numeric(78, 0) NOT NULL,
	"manifest_hash" text NOT NULL,
	"seats" integer NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_price_nonneg" CHECK ("resources"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text NOT NULL,
	"indices" integer[] NOT NULL,
	"verdict" text NOT NULL,
	"reason" text NOT NULL,
	"confidence" text,
	"prompt_hash" text,
	"output_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_history" (
	"seller_address" text PRIMARY KEY NOT NULL,
	"seller_id" text,
	"orders" integer DEFAULT 0 NOT NULL,
	"on_time_reveals" integer DEFAULT 0 NOT NULL,
	"late_reveals" integer DEFAULT 0 NOT NULL,
	"proven_cheats" integer DEFAULT 0 NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_transactions" ADD CONSTRAINT "chain_transactions_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_orders" ADD CONSTRAINT "escrow_orders_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_corrects_entry_id_financial_entries_id_fk" FOREIGN KEY ("corrects_entry_id") REFERENCES "public"."financial_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_groups" ADD CONSTRAINT "purchase_groups_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_groups" ADD CONSTRAINT "purchase_groups_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_purchase_group_id_purchase_groups_id_fk" FOREIGN KEY ("purchase_group_id") REFERENCES "public"."purchase_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_requests" ADD CONSTRAINT "resource_requests_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_requests" ADD CONSTRAINT "resource_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_at_idx" ON "activity_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "agents_organization_idx" ON "agents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "allocations_purchase_idx" ON "allocations" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "chain_transactions_purchase_idx" ON "chain_transactions" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "exceptions_status_idx" ON "exceptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "financial_entries_purchase_idx" ON "financial_entries" USING btree ("purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_active_mission_resource_uidx" ON "purchases" USING btree ("mission_id","resource_id") WHERE "purchases"."status" NOT IN ('SETTLED', 'REFUNDED', 'REJECTED', 'FAILED_BEFORE_FUNDING', 'RELEASED');--> statement-breakpoint
CREATE INDEX "purchases_mission_idx" ON "purchases" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "purchases_status_idx" ON "purchases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "resource_requests_mission_idx" ON "resource_requests" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "samples_purchase_idx" ON "samples" USING btree ("purchase_id");