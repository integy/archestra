-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign key and unique index target dev_feedback_submissions, created empty in this same migration, so no existing rows can violate them. Non-concurrent indexes cannot block existing writers on a new table. ON DELETE CASCADE intentionally removes a submitter's internal delivery records and retained recovery media when that user is deleted; it does not delete Slack messages.
CREATE TABLE "dev_feedback_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"author_name" text NOT NULL,
	"request_hash" text NOT NULL,
	"body" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"root_ts" text,
	"permalink" text,
	"delivery_status" text DEFAULT 'posting' NOT NULL,
	"media" jsonb NOT NULL,
	"dispatch_status" text DEFAULT 'disabled' NOT NULL,
	"runtime_task_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dev_feedback_submissions" ADD CONSTRAINT "dev_feedback_submissions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dev_feedback_submissions_delivery_idx" ON "dev_feedback_submissions" USING btree ("delivery_status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dev_feedback_submissions_thread_idx" ON "dev_feedback_submissions" USING btree ("organization_id",("target"->>'workspaceId'),("target"->>'channelId'),"root_ts");