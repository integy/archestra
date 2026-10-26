import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FeedbackMediaOutcomes } from "@/database/schemas/dev-feedback-submission";
import type {
  CreateDevFeedbackCommentBody,
  DevFeedbackSetup,
} from "@/types/dev-feedback";
import TaskModel from "./task";

const table = schema.devFeedbackSubmissionsTable;

class DevFeedbackSubmissionModel {
  static async create(params: {
    id: string;
    organizationId: string;
    actorUserId: string;
    authorName: string;
    requestHash: string;
    body: CreateDevFeedbackCommentBody;
    target: DevFeedbackSetup;
  }) {
    const [created] = await db
      .insert(table)
      .values({
        ...params,
        // Claim/reconciliation tokens round-trip through JavaScript Date at millisecond precision.
        updatedAt: new Date(),
        media: {
          screenshot: params.body.screenshot ? "unknown" : "absent",
          clip: params.body.clip ? "unknown" : "absent",
        },
        dispatchStatus: params.target.agentId ? "pending" : "disabled",
      })
      .onConflictDoNothing()
      .returning();
    return {
      created: !!created,
      report: created ?? (await DevFeedbackSubmissionModel.findById(params.id)),
    };
  }

  static async findById(id: string) {
    const [report] = await db.select().from(table).where(eq(table.id, id));
    return report ?? null;
  }

  static async findStaleDeliveries() {
    return db
      .select()
      .from(table)
      .where(
        and(
          inArray(table.deliveryStatus, [
            "posting",
            "uncertain",
            "media_pending",
          ]),
          lt(table.updatedAt, new Date(Date.now() - 120_000)),
        ),
      )
      .orderBy(asc(table.updatedAt), asc(table.id))
      .limit(20);
  }

  static async deferDeliveryReconciliation(id: string, observedAt: Date) {
    await db
      .update(table)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(table.id, id),
          eq(table.updatedAt, observedAt),
          inArray(table.deliveryStatus, [
            "posting",
            "uncertain",
            "media_pending",
          ]),
        ),
      );
  }

  static async findOrphanedDispatches() {
    return db
      .select()
      .from(table)
      .where(
        and(
          eq(table.deliveryStatus, "posted"),
          inArray(table.dispatchStatus, ["pending", "launching"]),
          lt(table.updatedAt, new Date(Date.now() - 120_000)),
          noLiveDispatchJob(),
        ),
      )
      .orderBy(asc(table.updatedAt), asc(table.id))
      .limit(20);
  }

  static async settleOrphanedDispatch(params: {
    id: string;
    observedAt: Date;
    status: "started" | "failed" | "uncertain";
    message: string | null;
  }) {
    await db
      .update(table)
      .set({
        dispatchStatus: params.status,
        lastError: params.message,
        updatedAt: new Date(),
        ...(params.status === "started" && {
          body: sql`${table.body} - 'screenshot' - 'clip'`,
        }),
      })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.updatedAt, params.observedAt),
          eq(table.deliveryStatus, "posted"),
          inArray(table.dispatchStatus, ["pending", "launching"]),
          noLiveDispatchJob(),
        ),
      );
  }

  static async findOwnedComments(params: {
    rootTs: string[];
    organizationId: string;
    actorUserId: string;
    target: DevFeedbackSetup;
  }) {
    if (params.rootTs.length === 0) return [];
    return db
      .select()
      .from(table)
      .where(
        and(
          inArray(table.rootTs, params.rootTs),
          eq(table.organizationId, params.organizationId),
          eq(table.actorUserId, params.actorUserId),
          sql`${table.target}->>'channelId' = ${params.target.channelId}`,
          sql`${table.target}->>'botId' = ${params.target.botId}`,
          params.target.workspaceId
            ? sql`${table.target}->>'workspaceId' = ${params.target.workspaceId}`
            : sql`${table.target}->>'workspaceId' IS NULL`,
        ),
      );
  }

  /** The confirmed root and its durable job commit together, before optional thread uploads. */
  static async recordRoot(params: {
    id: string;
    rootTs: string;
    permalink: string | null;
    screenshot: FeedbackMediaOutcomes["screenshot"];
  }) {
    return db.transaction(async (tx) => {
      const [report] = await tx
        .update(table)
        .set({
          rootTs: params.rootTs,
          permalink: params.permalink,
          deliveryStatus: "media_pending",
          media: sql`jsonb_set(${table.media}, '{screenshot}', ${JSON.stringify(params.screenshot)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(and(eq(table.id, params.id), isNull(table.rootTs)))
        .returning();
      if (report?.target.agentId)
        await TaskModel.create(
          {
            taskType: "dev_feedback_dispatch",
            payload: { reportId: params.id },
            maxAttempts: 8,
            scheduledFor: new Date(Date.now() + 60_000),
          },
          tx,
        );
      return report ?? (await DevFeedbackSubmissionModel.findById(params.id));
    });
  }

  static async finishDelivery(id: string, media: FeedbackMediaOutcomes) {
    return db.transaction(async (tx) => {
      await tx
        .update(table)
        .set({ deliveryStatus: "posted", media, updatedAt: new Date() })
        .where(
          and(
            eq(table.id, id),
            inArray(table.deliveryStatus, ["media_pending", "uncertain"]),
          ),
        );
      await tx
        .update(schema.tasksTable)
        .set({ scheduledFor: new Date() })
        .where(
          and(
            eq(schema.tasksTable.taskType, "dev_feedback_dispatch"),
            eq(schema.tasksTable.status, "pending"),
            sql`${schema.tasksTable.payload}->>'reportId' = ${id}`,
          ),
        );
      await tx
        .update(table)
        .set({ body: sql`${table.body} - 'screenshot' - 'clip'` })
        .where(
          and(
            eq(table.id, id),
            eq(table.dispatchStatus, "disabled"),
            eq(table.deliveryStatus, "posted"),
          ),
        );
    });
  }

  static async markDeliveryUncertain(id: string) {
    await db
      .update(table)
      .set({
        deliveryStatus: "uncertain",
        lastError:
          "Slack delivery could not be confirmed. Retry this same report to reconcile it; do not submit a replacement.",
        updatedAt: new Date(),
      })
      .where(and(eq(table.id, id), isNull(table.rootTs)));
  }

  /** A lease protects in-process duplicates; only an unlinked stale launch may be retried. */
  static async claimDispatch(id: string) {
    const [claimed] = await db
      .update(table)
      .set({
        dispatchStatus: "launching",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(table.id, id),
          eq(table.deliveryStatus, "posted"),
          isNull(table.runtimeTaskId),
          inArray(table.dispatchStatus, ["pending", "failed"]),
        ),
      )
      .returning();
    return claimed ?? null;
  }

  static async recoverUnlinkedLaunch(id: string) {
    await db
      .update(table)
      .set({ dispatchStatus: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(table.id, id),
          eq(table.dispatchStatus, "launching"),
          isNull(table.runtimeTaskId),
          lt(table.updatedAt, new Date(Date.now() - 120_000)),
        ),
      );
  }

  static async linkTask(id: string, taskId: string, claimedAt: Date) {
    const [linked] = await db
      .update(table)
      .set({ runtimeTaskId: taskId, updatedAt: new Date() })
      .where(
        and(
          eq(table.id, id),
          eq(table.dispatchStatus, "launching"),
          isNull(table.runtimeTaskId),
          eq(table.updatedAt, claimedAt),
        ),
      )
      .returning({ id: table.id });
    return !!linked;
  }

  static async failOwnedLaunch(params: {
    id: string;
    claimedAt: Date;
    status: "failed" | "pending";
    message: string;
  }) {
    await db
      .update(table)
      .set({
        dispatchStatus: params.status,
        lastError: params.message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.dispatchStatus, "launching"),
          eq(table.updatedAt, params.claimedAt),
          isNull(table.runtimeTaskId),
        ),
      );
  }

  static async settleDispatch(
    id: string,
    status: "pending" | "started" | "failed" | "uncertain",
    message: string | null = null,
  ) {
    await db
      .update(table)
      .set({
        dispatchStatus: status,
        lastError: message,
        updatedAt: new Date(),
        ...(status === "started" && {
          body: sql`${table.body} - 'screenshot' - 'clip'`,
        }),
      })
      .where(eq(table.id, id));
  }
}

export default DevFeedbackSubmissionModel;

function noLiveDispatchJob() {
  return sql`NOT EXISTS (SELECT 1 FROM ${schema.tasksTable} WHERE ${schema.tasksTable.taskType} = 'dev_feedback_dispatch' AND ${schema.tasksTable.payload}->>'reportId' = ${table.id}::text AND ${schema.tasksTable.status} IN ('pending', 'processing'))`;
}
