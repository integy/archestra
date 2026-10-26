import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

test("scoped worker completes only its approved task and leaves unrelated recovery alone", async () => {
  const client = new PGlite();
  await client.exec(`CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending',
    attempt integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
    scheduled_for timestamp NOT NULL DEFAULT now(), started_at timestamp,
    heartbeat_at timestamp, completed_at timestamp, last_error text,
    periodic boolean NOT NULL DEFAULT false, created_at timestamp NOT NULL DEFAULT now()
  )`);
  const database = await import("../src/database/index.ts");
  database.__setTestDb(drizzle(client));
  const { default: config } = await import("../src/config.ts");
  const { default: TaskModel } = await import("../src/models/task.ts");
  const { TaskQueueService } = await import("../src/task-queue/task-queue.ts");
  const originalInterval = config.kb.taskWorkerPollIntervalSeconds;
  config.kb.taskWorkerPollIntervalSeconds = 0.02;
  const approved = randomUUID();
  const other = randomUUID();
  const stale = randomUUID();
  await client.query(`INSERT INTO tasks(id,task_type,status,heartbeat_at,started_at)
    VALUES($1,'dev_feedback_dispatch','pending',NULL,NULL),
      ($2,'dev_feedback_dispatch','pending',NULL,NULL),
      ($3,'connector_sync','processing',now()-interval '1 hour',now()-interval '1 hour')`,
    [other, approved, stale]);
  const worker = new TaskQueueService({ taskType: "dev_feedback_dispatch", taskIds: [approved, stale] });
  let calls = 0;
  worker.registerHandler("dev_feedback_dispatch", async (_payload, context) => {
    assert.equal(context.taskId, approved);
    calls++;
  });
  try {
    worker.startWorker();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = (await client.query("SELECT status FROM tasks WHERE id=$1", [approved])).rows[0];
      if (row.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await worker.stopWorker();
    const rows = (await client.query("SELECT id,status,attempt FROM tasks")).rows;
    assert.equal(calls, 1);
    assert.equal(rows.find((row) => row.id === approved).status, "completed");
    assert.equal(rows.find((row) => row.id === other).status, "pending");
    assert.equal(rows.find((row) => row.id === other).attempt, 0);
    assert.equal(rows.find((row) => row.id === stale).status, "processing");
    const next = await TaskModel.dequeue(["dev_feedback_dispatch"]);
    assert.equal(next.id, other, "unscoped dequeue retains its existing behavior");
  } finally {
    await worker.stopWorker();
    config.kb.taskWorkerPollIntervalSeconds = originalInterval;
    database.__setTestDb(null);
    await client.close();
  }
});

test("inbound opt-out also protects provider reinitialization", async () => {
  const client = new PGlite();
  const database = await import("../src/database/index.ts");
  let attemptedQueries = 0;
  database.__setTestDb(drizzle(client, { logger: { logQuery() { attemptedQueries++; } } }));
  const { default: config } = await import("../src/config.ts");
  const { ChatOpsManager } = await import("../src/agents/chatops/chatops-manager.ts");
  const original = config.chatops.inboundEnabled;
  config.chatops.inboundEnabled = false;
  try {
    const manager = new ChatOpsManager();
    await manager.initialize();
    await manager.reinitialize();
    assert.equal(manager.isAnyProviderConfigured(), false);
    assert.equal(attemptedQueries, 0, "disabled inbound must not even attempt configuration reads or seeding");
  } finally {
    config.chatops.inboundEnabled = original;
    database.__setTestDb(null);
    await client.close();
  }
});
