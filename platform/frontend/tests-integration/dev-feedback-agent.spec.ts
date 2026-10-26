import { expect, test } from "./fixtures";

const agentId = "00000000-0000-4000-8000-000000000001";

test("feedback setup selects an agent and a captured report retains its identity when retried", async ({
  page,
  mswControl,
  request,
}) => {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  const agent = {
    id: agentId,
    name: "Feedback reviewer",
    agentType: "agent",
    runtime: { image: "example/runtime:1", backend: "kubernetes" },
  };
  const agentPage = {
    data: [agent],
    pagination: { hasNext: false, nextCursor: null, limit: 20 },
  };
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/config",
      body: {
        ...config,
        features: { ...config.features, devFeedbackEnabled: true },
      },
    },
    {
      method: "get",
      url: "/api/dev-feedback/setup",
      body: { configured: false, channelName: null },
    },
    {
      method: "get",
      url: "/api/dev-feedback/setup/bots",
      body: [{ id: "A1", name: "Feedback bot" }],
    },
    {
      method: "get",
      url: "/api/dev-feedback/setup/bots/A1/channels",
      body: [{ id: "C1", name: "feedback", isPrivate: false }],
    },
    { method: "get", url: "/api/agents/options/page", body: agentPage },
    { method: "get", url: "/api/agents/options", body: agentPage },
    { method: "get", url: "/api/dev-feedback/comments", body: [] },
    {
      method: "put",
      url: "/api/dev-feedback/setup",
      body: {
        configured: true,
        channelName: "feedback",
        agentId,
        agentName: agent.name,
      },
    },
  ]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext("2d");
        const draw = () => {
          if (!context) return;
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, 640, 480);
          context.fillStyle = "#111111";
          context.fillText("Feedback capture fixture", 20, 30);
        };
        draw();
        setInterval(draw, 100);
        return canvas.captureStream(10);
      },
    });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: "Comment on this page" }).click();
  await page.getByRole("button", { name: "feedback", exact: true }).click();
  await page.getByRole("button", { name: "Feedback reviewer" }).click();
  await mswControl.use({
    method: "get",
    url: "/api/dev-feedback/setup",
    body: {
      configured: true,
      channelName: "feedback",
      agentId,
      agentName: agent.name,
    },
  });
  const save = page.waitForRequest(
    (r) => r.method() === "PUT" && r.url().endsWith("/api/dev-feedback/setup"),
  );
  await page.getByRole("button", { name: "Post to #feedback" }).click();
  expect((await save).postDataJSON()).toEqual({
    botId: "A1",
    channelId: "C1",
    agentId,
  });
  await page.getByRole("button", { name: "Comment on this page" }).click();
  await page
    .getByRole("heading", { name: "Agents", level: 1, exact: true })
    .click();
  await page.getByPlaceholder("Add a comment").fill("Preserve the full report");
  await mswControl.use({
    method: "post",
    url: "/api/dev-feedback/comments",
    status: 503,
    body: { error: { message: "Delivery not confirmed", type: "api_error" } },
  });
  const submit = page.waitForRequest(
    (r) =>
      r.method() === "POST" && r.url().endsWith("/api/dev-feedback/comments"),
  );
  await page
    .getByRole("button", { name: "Post to Slack", exact: true })
    .click();
  const body = (await submit).postDataJSON();
  expect(body.submissionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(body.text).toBe("Preserve the full report");
  expect(body.screenshot.mimeType).toBe("image/jpeg");
  expect(body.screenshot.base64.length).toBeGreaterThan(100);
  await expect(
    page.getByRole("alert").filter({ hasText: "Retry to check this report" }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Add a comment")).toBeDisabled();
  await mswControl.use({
    method: "post",
    url: "/api/dev-feedback/comments",
    body: {
      ...body,
      id: "1729426801.000100",
      authorName: "Reporter",
      replyCount: 0,
      permalink: null,
      createdAt: "2026-10-26T12:00:00.000Z",
      dispatch: { status: "pending", runId: null, message: null },
    },
  });
  const retry = page.waitForRequest(
    (r) =>
      r.method() === "POST" && r.url().endsWith("/api/dev-feedback/comments"),
  );
  await page.getByRole("button", { name: "Retry feedback" }).click();
  expect((await retry).postDataJSON()).toEqual(body);
  await expect(
    page.getByText("Agent review is queued for this Slack thread."),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Add a comment")).toHaveCount(0);
});
