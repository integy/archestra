import type { A2AAttachment } from "@/agents/a2a-executor";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import config from "@/config";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import DevFeedbackSubmissionModel from "@/models/dev-feedback-submission";
import { ApiError } from "@/types";
import type { DevFeedbackSubmission } from "@/types/dev-feedback-submission";
import type { TaskHandlerContext } from "@/types/task";

export async function handleDevFeedbackDispatch(
  payload: Record<string, unknown>,
  context?: TaskHandlerContext,
): Promise<void> {
  if (typeof payload.reportId !== "string")
    throw new Error("Missing feedback report id");
  if (!config.devFeedback.enabled)
    throw new Error("Feedback dispatch is disabled");
  let report = await DevFeedbackSubmissionModel.findById(payload.reportId);
  if (
    !report ||
    !report.target.agentId ||
    ["started", "uncertain", "disabled"].includes(report.dispatchStatus)
  )
    return;
  if (report.deliveryStatus === "media_pending") {
    if (Date.now() - report.updatedAt.getTime() < 120_000)
      throw new Error("Feedback media upload is still settling");
    await DevFeedbackSubmissionModel.finishDelivery(report.id, report.media);
    report = await DevFeedbackSubmissionModel.findById(report.id);
  }
  if (!report || report.deliveryStatus !== "posted")
    throw new Error("The Slack report has not been confirmed");
  if (report.runtimeTaskId) {
    const run = await AgentRunModel.findByTaskId(report.runtimeTaskId);
    if (run) {
      await DevFeedbackSubmissionModel.settleDispatch(report.id, "started");
      return;
    }
    if (Date.now() - report.updatedAt.getTime() < 120_000)
      throw new Error("Waiting for the linked feedback runtime to persist");
    await DevFeedbackSubmissionModel.settleDispatch(
      report.id,
      "uncertain",
      "Posted to Slack. A task was reserved but runtime startup could not be confirmed. Inspect the linked run before starting any replacement; this report will not automatically launch again.",
    );
    return;
  }
  await DevFeedbackSubmissionModel.recoverUnlinkedLaunch(report.id);
  const claimed = await DevFeedbackSubmissionModel.claimDispatch(report.id);
  if (!claimed) return;
  try {
    const result = await chatOpsManager.dispatchFeedbackReport({
      report: claimed,
      message: reportMessage(claimed),
      attachments: reportAttachments(claimed),
      onTaskCreated: async (taskId) => {
        if (
          await DevFeedbackSubmissionModel.linkTask(
            claimed.id,
            taskId,
            claimed.updatedAt,
          )
        )
          return;
        const task = await A2ATaskModel.findById(taskId);
        if (task)
          await A2ATaskModel.transitionStateWithEvent({
            id: taskId,
            to: "TASK_STATE_CANCELED",
            allowedFrom: ["TASK_STATE_SUBMITTED"],
            statusReason: "This feedback report already owns a task",
            eventPayload: {
              statusUpdate: {
                taskId,
                contextId: task.contextId,
                status: { state: "TASK_STATE_CANCELED" },
                final: true,
              },
            },
          });
        throw new ApiError(409, "Feedback report already has a runtime task");
      },
    });
    const linked = await DevFeedbackSubmissionModel.findById(claimed.id);
    if (!result.success && !linked?.runtimeTaskId)
      throw new Error(result.error || "Feedback Agent could not start");
    if (
      linked?.runtimeTaskId &&
      (await AgentRunModel.findByTaskId(linked.runtimeTaskId))
    ) {
      await DevFeedbackSubmissionModel.settleDispatch(claimed.id, "started");
      return;
    }
    // Detached launch continues after its handle returns. A retry observes that same handle.
    throw new Error("Waiting for the linked feedback runtime to persist");
  } catch (error) {
    const finalAttempt =
      !context || (context.attempt ?? 1) >= (context.maxAttempts ?? 1);
    await DevFeedbackSubmissionModel.failOwnedLaunch({
      id: claimed.id,
      claimedAt: claimed.updatedAt,
      status: finalAttempt ? "failed" : "pending",
      message:
        "Posted to Slack. Agent startup failed; check Agent access, credentials and feedback setup. No replacement report was posted.",
    });
    throw error;
  }
}

function reportMessage(report: DevFeedbackSubmission): string {
  return [
    `Handle this UI feedback report from ${report.authorName}. Preserve its full context when creating or updating work.`,
    `Report: ${report.id}\nPage: ${report.body.url}\nRoute: ${report.body.route}\nElement: ${report.body.label}\nSelector: ${report.body.selector}\nViewport: ${report.body.viewport}`,
    `Slack thread: ${report.permalink ?? report.rootTs}`,
    `Original report:\n${report.body.text}`,
    `Slack media delivery: screenshot=${report.media.screenshot}; recording=${report.media.clip}. Original supplied media are staged below even if Slack could not display them. A recording file being present does not establish that you can interpret video. Explain missing or unsupported media instead of guessing.`,
  ].join("\n\n");
}

function reportAttachments(report: DevFeedbackSubmission): A2AAttachment[] {
  const attachments: A2AAttachment[] = [];
  if (report.body.screenshot)
    attachments.push({
      name:
        report.body.screenshot.mimeType === "image/png"
          ? "screenshot.png"
          : "screenshot.jpg",
      contentType: report.body.screenshot.mimeType,
      contentBase64: report.body.screenshot.base64,
    });
  if (report.body.clip)
    attachments.push({
      name:
        report.body.clip.mimeType === "video/mp4" ? "clip.mp4" : "clip.webm",
      contentType: report.body.clip.mimeType,
      contentBase64: report.body.clip.base64,
    });
  return attachments;
}
