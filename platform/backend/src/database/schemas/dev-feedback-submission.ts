import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CreateDevFeedbackCommentBody,
  DevFeedbackSetup,
} from "@/types/dev-feedback";
import usersTable from "./user";

export type FeedbackMediaOutcome =
  | "absent"
  | "uploaded"
  | "unavailable"
  | "unknown";
export type FeedbackMediaOutcomes = {
  screenshot: FeedbackMediaOutcome;
  clip: FeedbackMediaOutcome;
};
export type FeedbackDeliveryStatus =
  | "posting"
  | "media_pending"
  | "posted"
  | "uncertain";
export type FeedbackDispatchStatus =
  | "disabled"
  | "pending"
  | "launching"
  | "started"
  | "failed"
  | "uncertain";

/** A report's delivery and invocation have separate retry boundaries. No Slack credentials are stored here. */
const devFeedbackSubmissionsTable = pgTable(
  "dev_feedback_submissions",
  {
    id: uuid("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    authorName: text("author_name").notNull(),
    requestHash: text("request_hash").notNull(),
    body: jsonb("body").$type<CreateDevFeedbackCommentBody>().notNull(),
    target: jsonb("target").$type<DevFeedbackSetup>().notNull(),
    rootTs: text("root_ts"),
    permalink: text("permalink"),
    deliveryStatus: text("delivery_status")
      .$type<FeedbackDeliveryStatus>()
      .notNull()
      .default("posting"),
    media: jsonb("media").$type<FeedbackMediaOutcomes>().notNull(),
    dispatchStatus: text("dispatch_status")
      .$type<FeedbackDispatchStatus>()
      .notNull()
      .default("disabled"),
    runtimeTaskId: uuid("runtime_task_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("dev_feedback_submissions_delivery_idx").on(
      table.deliveryStatus,
      table.updatedAt,
    ),
    uniqueIndex("dev_feedback_submissions_thread_idx").on(
      table.organizationId,
      sql`(${table.target}->>'workspaceId')`,
      sql`(${table.target}->>'channelId')`,
      table.rootTs,
    ),
  ],
);

export default devFeedbackSubmissionsTable;
