import { expect, test } from "./fixtures";

const agentId = "00000000-0000-4000-8000-000000000001";

test("feedback setup selects an agent and a captured report starts review", async ({
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
    body: {
      id: "1729426801.000100",
      route: "/agents",
      selector: "main",
      label: "Page",
      elementX: 0.5,
      elementY: 0.5,
      viewportX: 0.5,
      viewportY: 0.5,
      text: "Preserve the full report",
      authorName: "Reporter",
      replyCount: 0,
      permalink: null,
      createdAt: "2026-10-26T12:00:00.000Z",
      dispatch: { status: "started", runId: agentId, message: null },
    },
  });
  const submit = page.waitForRequest(
    (r) =>
      r.method() === "POST" && r.url().endsWith("/api/dev-feedback/comments"),
  );
  await page
    .getByRole("button", { name: "Post to Slack", exact: true })
    .click();
  const body = (await submit).postDataJSON();
  expect(body.text).toBe("Preserve the full report");
  expect(body.screenshot.mimeType).toBe("image/jpeg");
  expect(body.screenshot.base64.length).toBeGreaterThan(100);
  await expect(
    page.getByText(
      "Agent review started. Its response will appear in the Slack thread.",
    ),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Add a comment")).toHaveCount(0);
});
