import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  WORKFLOW_CONVENTION_QUESTIONS,
  buildWorkflowConventionsText,
} from "../../src/services/workflow-conventions.js";

// Issue #937 — the two small, read-only endpoints backing the Settings ->
// Sessions wizard: GET the fixed question set, POST answers -> assembled
// text. Neither reads nor writes settings.sessions.workflowConventionsText
// itself (the existing PATCH /api/settings already owns that) — see
// routes/workflow-conventions.ts's own header comment for why this
// deliberately avoids routes/project-setup.ts's heavier preview/apply
// worktree-diff machinery.
const tmpDb = path.join(os.tmpdir(), `workflow-conventions-route-test-${process.pid}.db`);

describe("workflow-conventions route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("GET /api/workflow-conventions/questions returns the full fixed question set", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/workflow-conventions/questions" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ questions: WORKFLOW_CONVENTION_QUESTIONS });
    await app.close();
  });

  it("POST /api/workflow-conventions/preview assembles text from answers, matching buildWorkflowConventionsText directly", async () => {
    const app = await buildApp();
    const answers = { branching: "branch-pr", mergeStrategy: "squash" };
    const res = await app.inject({
      method: "POST",
      url: "/api/workflow-conventions/preview",
      payload: { answers },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: buildWorkflowConventionsText(answers) });
    await app.close();
  });

  it("POST /api/workflow-conventions/preview with no answers returns an empty string", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/workflow-conventions/preview",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "" });
    await app.close();
  });

  it("POST /api/workflow-conventions/preview never persists anything into settings.sessions.workflowConventionsText", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/workflow-conventions/preview",
      payload: { answers: { branching: "branch-pr" } },
    });
    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().sessions.workflowConventionsText).toBe("");
    await app.close();
  });
});
