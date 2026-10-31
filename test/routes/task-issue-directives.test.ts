import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearHermesKey, setHermesKey } from "../../src/services/hermes-integration.js";

const tmpDb = path.join(os.tmpdir(), `mullion-task-directives-${process.pid}.db`);
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");

// The task detail dropdowns read issueAgent / issueReviewAgent: the issue
// body's directives, validated the way the resolvers validate them.
describe("GET /api/tasks/:id issue directives", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-directives-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "directives", cwd },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  const insert = (body: string | null) =>
    app.db
      .insert(tasks)
      .values({ projectId, title: "T", status: "backlog", body })
      .returning()
      .get().id;
  const get = async (id: number) =>
    (await app.inject({ method: "GET", url: `/api/tasks/${id}` })).json();

  it("exposes a known Agent: and a usable ReviewAgent:, in the list too", async () => {
    const id = insert("Agent: codex\nReviewAgent: claude\n");
    expect(await get(id)).toMatchObject({ issueAgent: "codex", issueReviewAgent: "claude" });
    const list = (await app.inject({ method: "GET", url: "/api/tasks" })).json();
    expect(list.find((t: { id: number }) => t.id === id)).toMatchObject({ issueAgent: "codex" });
  });

  it("reports hermes as none until Hermes is usable (no reviewer, no fall-through)", async () => {
    const id = insert("ReviewAgent: hermes");
    expect(await get(id)).toMatchObject({ issueReviewAgent: "none" });
    applySettingsPatch(app, {
      reviewRelay: { apiUrl: "http://hermes.test:8643", taskMasterReviewer: true },
    });
    setHermesKey(app, "test-key"); // pragma: allowlist secret
    try {
      expect(await get(id)).toMatchObject({ issueReviewAgent: "hermes" });
    } finally {
      clearHermesKey(app);
      applySettingsPatch(app, { reviewRelay: { apiUrl: "", taskMasterReviewer: false } });
    }
  });

  it("drops unknown names, keeps none/false as none, and null without directives", async () => {
    expect(await get(insert("Agent: bogus\nReviewAgent: bogus"))).toMatchObject({
      issueAgent: null,
      issueReviewAgent: null,
    });
    expect(await get(insert("ReviewAgent: false"))).toMatchObject({ issueReviewAgent: "none" });
    expect(await get(insert(null))).toMatchObject({ issueAgent: null, issueReviewAgent: null });
  });
});
