CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
