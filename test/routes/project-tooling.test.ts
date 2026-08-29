import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { MAX_PROJECT_BRIEFING_BYTES } from "../../src/services/project-tooling.js";

const tmpDb = path.join(os.tmpdir(), `project-tooling-test-${process.pid}.db`);

const VALID_SKILL = `---
name: my-project-skill
description: A project-specific skill for testing.
---

Do the project-specific thing.
`;

const VALID_REVIEWER_AGENT = `---
name: my-project-reviewer
description: Reviews diffs for this project's own invariants.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are reviewing a change in this project.
`;

async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { createDir: true, name: "tooling-test", cwd: "/tmp/tooling-test" },
  });
  return res.json().id as number;
}

describe("project-tooling route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("returns { briefing: null, skill: null, reviewerAgent: null } for a project with nothing authored — never 404", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/tooling` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ briefing: null, skill: null, reviewerAgent: null });

    await app.close();
  });

  it("404s for an unknown project id", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/projects/999999/tooling" });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("PUTs a briefing and reads it back", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "operator-authored instructions" },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual({ briefing: "operator-authored instructions" });

    const getRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}/tooling` });
    expect(getRes.json()).toEqual({
      briefing: "operator-authored instructions",
      skill: null,
      reviewerAgent: null,
    });

    await app.close();
  });

  it("PUT is an upsert — a second PUT replaces the row rather than erroring or duplicating", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "first version" },
    });
    const secondRes = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "second version" },
    });
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.json()).toEqual({ briefing: "second version" });

    await app.close();
  });

  it("rejects a briefing over MAX_PROJECT_BRIEFING_BYTES with 400, not 500", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "a".repeat(MAX_PROJECT_BRIEFING_BYTES + 1) },
    });
    expect(res.statusCode).toBe(400);

    // Nothing was written — the byte-length check runs before any DB write.
    const getRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}/tooling` });
    expect(getRes.json().briefing).toBeNull();

    await app.close();
  });

  it("DELETE clears the briefing field — GET afterward reports null again, not the empty string", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: { briefing: "to be deleted" },
    });
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/tooling`,
    });
    expect(delRes.statusCode).toBe(204);

    const getRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}/tooling` });
    expect(getRes.json().briefing).toBeNull();

    await app.close();
  });

  it("DELETE on a project with no row is a no-op 204, not an error", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/tooling` });
    expect(res.statusCode).toBe(204);

    await app.close();
  });

  it("rejects a PUT body missing briefing entirely", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/tooling`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  describe("skill field", () => {
    it("PUTs a valid skill and reads it back", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/skill`,
        payload: { skill: VALID_SKILL },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json()).toEqual({ skill: VALID_SKILL });

      const getRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}/tooling` });
      expect(getRes.json().skill).toBe(VALID_SKILL);

      await app.close();
    });

    it("rejects content with no parseable frontmatter", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/skill`,
        payload: { skill: "not a skill file at all" },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("rejects a skill over MAX_PROJECT_BRIEFING_BYTES with 400, not 500", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const oversized =
        "---\nname: too-big\ndescription: oversized\n---\n" +
        "a".repeat(MAX_PROJECT_BRIEFING_BYTES);
      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/skill`,
        payload: { skill: oversized },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("rejects a dangerous frontmatter name", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/skill`,
        payload: {
          skill: "---\nname: __proto__\ndescription: nope\n---\nbody",
        },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    // Hermes review, PR #894 — a traversal-shaped frontmatter name must be
    // rejected here, at write time, not merely skipped later at spawn time.
    it("rejects a path-traversal frontmatter name", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/skill`,
        payload: {
          skill: "---\nname: ../../etc/passwd\ndescription: nope\n---\nbody",
        },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("DELETE clears only the skill field, leaving briefing intact", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling`,
        payload: { briefing: "keep me" },
      });
      await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/skill`,
        payload: { skill: VALID_SKILL },
      });
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/tooling/skill`,
      });
      expect(delRes.statusCode).toBe(204);

      const getRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}/tooling` });
      expect(getRes.json()).toEqual({ briefing: "keep me", skill: null, reviewerAgent: null });

      await app.close();
    });
  });

  describe("reviewerAgent field", () => {
    it("PUTs a valid reviewer agent and reads it back", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/reviewer-agent`,
        payload: { reviewerAgent: VALID_REVIEWER_AGENT },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json()).toEqual({ reviewerAgent: VALID_REVIEWER_AGENT });

      await app.close();
    });

    it("rejects content with no parseable frontmatter", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/reviewer-agent`,
        payload: { reviewerAgent: "not a subagent file" },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("DELETE clears only the reviewerAgent field, leaving skill intact", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/skill`,
        payload: { skill: VALID_SKILL },
      });
      await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/reviewer-agent`,
        payload: { reviewerAgent: VALID_REVIEWER_AGENT },
      });
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/tooling/reviewer-agent`,
      });
      expect(delRes.statusCode).toBe(204);

      const getRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}/tooling` });
      expect(getRes.json()).toEqual({ briefing: null, skill: VALID_SKILL, reviewerAgent: null });

      await app.close();
    });

    it("clearing the last remaining field actually deletes the row (a subsequent independent PUT still works)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/tooling/reviewer-agent`,
        payload: { reviewerAgent: VALID_REVIEWER_AGENT },
      });
      await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/tooling/reviewer-agent`,
      });

      const getRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}/tooling` });
      expect(getRes.json()).toEqual({ briefing: null, skill: null, reviewerAgent: null });

      await app.close();
    });
  });
});
