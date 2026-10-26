import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2ATaskModel,
  AgentRunModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import AgentRunInputModel from "@/models/agent-run-input";
import DevFeedbackConfigModel from "@/models/dev-feedback-config";
import DevFeedbackSubmissionModel from "@/models/dev-feedback-submission";
import TaskModel from "@/models/task";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import type { AgentRunCompletion } from "@/services/agent-runtime/backends/types";
import { devFeedbackService } from "@/services/dev-feedback";
import { handleDevFeedbackDispatch } from "@/task-queue/handlers/dev-feedback-dispatch-handler";
import { afterEach, describe, expect, test, vi } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { FakeSlack } from "@/test/fake-slack";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import { CreateDevFeedbackCommentBodySchema } from "@/types/dev-feedback";
import { drainBackgroundWork } from "@/utils/background-work";
import devFeedbackRoutes from "./dev-feedback.routes";

setupTestCacheManager();
afterEach(async () => {
  await drainBackgroundWork();
  vi.restoreAllMocks();
});

describe("feedback delivery and direct dispatch", () => {
  const ctx = useRouteTestApp(devFeedbackRoutes);
  const server = useMswServer();

  test("replays a submitted report without reposting and drops post-only media from the ledger", async () => {
    const slack = new FakeSlack("CFEEDBACK");
    await slack.configureAsDevFeedbackChannel();
    server.use(...slack.handlers());
    const payload = body();
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    const retry = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
    expect(slack.messages).toHaveLength(1);
    const stored = await DevFeedbackSubmissionModel.findById(
      payload.submissionId,
    );
    expect(stored?.actorUserId).toBe(ctx.user.id);
    expect(stored?.organizationId).toBe(ctx.organizationId);
    expect(stored?.body.screenshot).toBeUndefined();
    const changed = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: { ...payload, text: "Replacement text" },
    });
    expect(changed.statusCode).toBe(409);
    expect(slack.messages).toHaveLength(1);
  });

  test("reconciles a lost Slack acknowledgement using the saved posting bot and submission id", async () => {
    const slack = new FakeSlack("CFEEDBACK");
    await slack.configureAsDevFeedbackChannel();
    server.use(...slack.handlers());
    server.use(
      http.post(
        "https://slack.com/api/chat.postMessage",
        async ({ request }) => {
          const params = new URLSearchParams(await request.text());
          slack.addMessage({
            text: params.get("text") ?? "",
            botId: "B1",
            metadata: JSON.parse(params.get("metadata") ?? "{}"),
          });
          return HttpResponse.json({ ok: false, error: "operation_timeout" });
        },
      ),
    );
    const payload = body({ screenshot: undefined });
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    expect(first.statusCode).toBe(500);
    const retry = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(slack.messages[0].ts);
    expect(slack.messages).toHaveLength(1);
  });

  test("keeps Slack success when dispatch fails and exposes its status only to the authenticated submitter", async ({
    makeUser,
  }) => {
    const slack = new FakeSlack("CFEEDBACK");
    await slack.configureAsDevFeedbackChannel();
    await DevFeedbackConfigModel.save({
      botId: "A1",
      channelId: slack.channel,
      channelName: "ui-feedback",
      organizationId: ctx.organizationId,
      agentId: randomUUID(),
    });
    server.use(...slack.handlers());
    const payload = body();
    const posted = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    expect(posted.statusCode).toBe(200);
    await expect(
      handleDevFeedbackDispatch({ reportId: payload.submissionId }),
    ).rejects.toThrow();
    const retry = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().dispatch.status).toBe("failed");
    expect(slack.messages).toHaveLength(1);
    const own = await ctx.app.inject({
      method: "GET",
      url: "/api/dev-feedback/comments?route=/llm/limits",
    });
    expect(own.json()[0].dispatch.status).toBe("failed");
    ctx.user = await makeUser();
    const other = await ctx.app.inject({
      method: "GET",
      url: "/api/dev-feedback/comments?route=/llm/limits",
    });
    expect(other.json()[0].dispatch).toBeUndefined();
    const spoofedRetry = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    expect(spoofedRetry.statusCode).toBe(409);
    expect(slack.messages).toHaveLength(1);
  });

  test("unreconciled reports rotate out of a bounded delivery batch so later reports recover", async () => {
    const slack = new FakeSlack("CFEEDBACK");
    await slack.configureAsDevFeedbackChannel();
    server.use(...slack.handlers());
    const reports = [];
    for (let index = 0; index < 21; index++) {
      const payload = CreateDevFeedbackCommentBodySchema.parse(
        body(
          index === 20
            ? { submissionId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }
            : {},
        ),
      );
      const saved = await DevFeedbackSubmissionModel.create({
        id: payload.submissionId as string,
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        authorName: ctx.user.name,
        requestHash: "fixture",
        body: payload,
        target: {
          botId: "A1",
          channelId: slack.channel,
          channelName: "ui-feedback",
        },
      });
      if (!saved.report) throw new Error("Missing feedback fixture");
      reports.push(saved.report);
    }
    const recoverable = reports[20];
    const delivered = slack.addMessage({
      text: recoverable.body.text,
      botId: "B1",
      metadata: {
        event_type: "archestra_dev_feedback_comment",
        event_payload: {
          submissionId: recoverable.id,
          authorName: ctx.user.name,
        },
      },
    });
    // Age untouched freshly inserted rows: a crash can leave PostgreSQL's initial timestamp here.
    const sweepStartedAt = new Date();
    vi.spyOn(Date, "now").mockReturnValue(sweepStartedAt.getTime() + 180_000);
    await devFeedbackService.reconcilePendingSubmissions();
    for (const failed of reports.slice(0, 20)) {
      expect(
        (
          await DevFeedbackSubmissionModel.findById(failed.id)
        )?.updatedAt.getTime(),
      ).toBeGreaterThanOrEqual(sweepStartedAt.getTime());
    }
    expect(
      (await DevFeedbackSubmissionModel.findById(recoverable.id))?.rootTs,
    ).toBeNull();
    await devFeedbackService.reconcilePendingSubmissions();
    expect(
      await DevFeedbackSubmissionModel.findById(recoverable.id),
    ).toMatchObject({ rootTs: delivered.ts, deliveryStatus: "posted" });
    expect(slack.messages).toHaveLength(1);
  });

  test.for([
    false,
    true,
  ])("a final queue-worker crash settles an abandoned dispatch without starting a replacement (task linked=%s)", async (linked) => {
    config.devFeedback.enabled = true;
    const payload = CreateDevFeedbackCommentBodySchema.parse(body());
    const reportId = payload.submissionId as string;
    await DevFeedbackSubmissionModel.create({
      id: reportId,
      organizationId: ctx.organizationId,
      actorUserId: ctx.user.id,
      authorName: ctx.user.name,
      requestHash: "fixture",
      body: payload,
      target: {
        botId: "A1",
        channelId: "CFEEDBACK",
        channelName: "ui-feedback",
        agentId: randomUUID(),
        organizationId: ctx.organizationId,
      },
    });
    await DevFeedbackSubmissionModel.recordRoot({
      id: reportId,
      rootTs: "1700000000.000001",
      permalink: null,
      screenshot: "uploaded",
    });
    await DevFeedbackSubmissionModel.finishDelivery(reportId, {
      screenshot: "uploaded",
      clip: "absent",
    });
    await db
      .update(schema.tasksTable)
      .set({ attempt: 7 })
      .where(eq(schema.tasksTable.taskType, "dev_feedback_dispatch"));
    const job = await TaskModel.dequeue(["dev_feedback_dispatch"]);
    expect(job?.attempt).toBe(8);
    const claim = await DevFeedbackSubmissionModel.claimDispatch(reportId);
    if (!claim || !job) throw new Error("Missing claimed dispatch fixture");
    const taskId = linked ? randomUUID() : null;
    if (taskId)
      expect(
        await DevFeedbackSubmissionModel.linkTask(
          reportId,
          taskId,
          claim.updatedAt,
        ),
      ).toBe(true);
    await db
      .update(schema.devFeedbackSubmissionsTable)
      .set({ updatedAt: new Date(Date.now() - 300_000) })
      .where(eq(schema.devFeedbackSubmissionsTable.id, reportId));
    await db
      .update(schema.tasksTable)
      .set({ heartbeatAt: sql`NOW() - interval '5 minutes'` })
      .where(eq(schema.tasksTable.id, job.id));
    expect(await TaskModel.resetStuckTasks(120_000)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskType: "dev_feedback_dispatch",
          status: "dead",
        }),
      ]),
    );
    await devFeedbackService.reconcilePendingSubmissions();
    expect(await DevFeedbackSubmissionModel.findById(reportId)).toMatchObject({
      dispatchStatus: linked ? "uncertain" : "failed",
      runtimeTaskId: taskId,
      lastError: expect.stringContaining("Posted to Slack"),
    });
    await devFeedbackService.reconcilePendingSubmissions();
    expect(await DevFeedbackSubmissionModel.findById(reportId)).toMatchObject({
      dispatchStatus: linked ? "uncertain" : "failed",
      runtimeTaskId: taskId,
    });
  });

  test("a worker with no inbound Slack provider launches once with the human report and media, then replies in its root thread", async ({
    makeMember,
    makeInternalAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    config.agentRuntime.platformBaseUrl = "https://platform.example.test";
    vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(backend, "assertReady").mockResolvedValue();
    vi.spyOn(backend, "resolveRuntimeScope").mockReturnValue("test-runtime");
    const launch = vi.spyOn(backend, "launch").mockResolvedValue();
    const stage = vi.spyOn(backend, "stageInputs").mockResolvedValue();
    vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
    vi.spyOn(backend, "getWorkspaceConnection").mockResolvedValue(null);
    vi.spyOn(backend, "streamOutput").mockImplementation(
      async ({ destination }) => {
        destination.end("Feedback investigated.\n");
      },
    );
    vi.spyOn(backend, "snapshotOutput").mockImplementation(
      async ({ destination }) => {
        destination.end("Feedback investigated.\n");
      },
    );
    let finish!: (completion: AgentRunCompletion) => void;
    vi.spyOn(backend, "waitForCompletion").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const key = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
      provider: "openai",
    });
    const model = await ModelModel.create({
      externalId: "openai/test-feedback-model",
      provider: "openai",
      modelId: "test-feedback-model",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      modelId: model.id,
      llmApiKeyId: key.id,
      runtime: {
        image: "example.test/feedback-worker:1",
        command: ["feedback-worker"],
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: null,
        ttlHours: null,
        idleTimeoutMinutes: null,
      },
    });
    const slack = new FakeSlack("CFEEDBACK");
    await slack.connectChatOpsBot();
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "test-signature",
      appId: "A1",
      connectionMode: "webhook",
    });
    server.use(
      ...slack.handlers(),
      http.post("https://slack.com/api/agents.sessions.setStatus", () =>
        HttpResponse.json({ ok: true }),
      ),
      http.post(
        "http://127.0.0.1:9000/v1/openai/:agentId/chat/completions",
        () =>
          HttpResponse.json(
            { error: { message: "Title unavailable" } },
            { status: 400 },
          ),
      ),
    );
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: ctx.organizationId,
      provider: "slack",
      channelId: slack.channel,
      workspaceId: "T1",
      agentId: agent.id,
    });
    await ChatOpsChannelBindingModel.update(binding.id, {
      channelInstructions:
        "Follow the configured feedback triage workflow before creating work.",
    });
    const setup = await ctx.app.inject({
      method: "PUT",
      url: "/api/dev-feedback/setup",
      payload: { botId: "A1", channelId: slack.channel, agentId: agent.id },
    });
    expect(setup.statusCode).toBe(200);
    const payload = body({
      clip: {
        mimeType: "video/mp4",
        base64: Buffer.from("recording-bytes").toString("base64"),
      },
    });
    const posted = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().dispatch.status).toBe("pending");
    await Promise.allSettled([
      handleDevFeedbackDispatch({ reportId: payload.submissionId }),
      handleDevFeedbackDispatch({ reportId: payload.submissionId }),
    ]);
    await expect.poll(() => launch.mock.calls.length).toBe(1);
    const linked = await DevFeedbackSubmissionModel.findById(
      payload.submissionId,
    );
    const taskId = linked?.runtimeTaskId as string;
    expect(taskId).toEqual(expect.any(String));
    await expect
      .poll(async () => !!(await AgentRunModel.findByTaskId(taskId)))
      .toBe(true);
    // A worker can die after the durable runtime appears but before recording dispatch success.
    await db
      .update(schema.devFeedbackSubmissionsTable)
      .set({
        dispatchStatus: "launching",
        updatedAt: new Date(Date.now() - 300_000),
      })
      .where(eq(schema.devFeedbackSubmissionsTable.id, payload.submissionId));
    await db
      .update(schema.tasksTable)
      .set({ status: "dead" })
      .where(eq(schema.tasksTable.taskType, "dev_feedback_dispatch"));
    await devFeedbackService.reconcilePendingSubmissions();
    expect(
      (await DevFeedbackSubmissionModel.findById(payload.submissionId))
        ?.dispatchStatus,
    ).toBe("started");
    const run = await AgentRunModel.findByTaskId(taskId);
    expect(run).toMatchObject({
      actorUserId: ctx.user.id,
      organizationId: ctx.organizationId,
      completionTarget: {
        type: "chatops",
        bindingId: binding.id,
        threadId: posted.json().id,
      },
    });
    const inputs = await AgentRunInputModel.findByTaskId(taskId);
    expect(inputs.map((input) => input.originalName).sort()).toEqual([
      "clip.mp4",
      "screenshot.jpg",
    ]);
    expect(
      inputs
        .find((input) => input.originalName === "clip.mp4")
        ?.fileData.toString(),
    ).toBe("recording-bytes");
    expect(stage).toHaveBeenCalledOnce();
    expect(JSON.stringify(launch.mock.calls[0][0])).toContain(
      "Accordion opens the wrong row",
    );
    expect(JSON.stringify(launch.mock.calls[0][0])).toContain("/llm/limits");
    expect(JSON.stringify(launch.mock.calls[0][0])).toContain(
      "Follow the configured feedback triage workflow before creating work.",
    );
    expect(
      (await DevFeedbackSubmissionModel.findById(payload.submissionId))?.body
        .screenshot,
    ).toBeUndefined();
    finish({ outcome: "succeeded" });
    await expect
      .poll(async () => (await A2ATaskModel.findById(taskId))?.state)
      .toBe("TASK_STATE_COMPLETED");
    await expect
      .poll(
        () =>
          slack.messages.filter(
            (message) => message.threadTs === posted.json().id,
          ).length,
      )
      .toBe(1);
    expect(slack.messages.filter((message) => !message.threadTs)).toHaveLength(
      1,
    );
    await handleDevFeedbackDispatch({ reportId: payload.submissionId });
    expect(launch).toHaveBeenCalledOnce();
  });
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: randomUUID(),
    route: "/llm/limits",
    url: "https://frontend.example.test/llm/limits",
    selector: "main > section",
    label: "Limits accordion",
    elementX: 0.5,
    elementY: 0.5,
    viewportX: 0.5,
    viewportY: 0.5,
    viewport: "1440x900",
    text: "Accordion opens the wrong row",
    screenshot: {
      mimeType: "image/jpeg",
      base64: Buffer.from("screenshot-bytes").toString("base64"),
    },
    ...overrides,
  };
}
