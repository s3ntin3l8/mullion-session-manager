// Must come before any import that could load "node-pty"/"node:child_process"
// — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  createProject,
  mockSpawnModule,
  setupSessionsRouteLifecycle,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi, afterAll, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync, spawn as spawnChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../../src/db/schema.js";
import { gitEnv } from "../../src/services/git-env.js";

// Issue #3555 — "Preview this branch" for a LOCAL project, end to end through
// POST /api/previews with the REAL createSessionRecord (its reserved-env-key
// check included): only the process spawn is faked, the same way as the
// sessions-route suites. Before the fix the allocated port travelled as
// `env.PORT`, a reserved key, so the create was refused and the route
// answered 502 start_failed ("reserved-env-key: PORT").
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => mockSpawnModule(await importOriginal()));

const { buildApp } = await import("../../src/app.js");

setupSessionsRouteLifecycle("previews-local-branch");

// The preview routes only exist with a preview base host configured.
beforeAll(() => {
  process.env.PREVIEW_BASE_HOST = "preview.example.com";
});

const roots: string[] = [];
afterAll(() => {
  delete process.env.PREVIEW_BASE_HOST;
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "gc.auto=0", "-C", cwd, ...args], {
    stdio: "ignore",
    env: {
      ...gitEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

/** A repo with a `feat/x` branch and a dock whose preview control reads $PORT. */
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "previews-local-branch-"));
  roots.push(root);
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  git(cwd, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "init");
  git(cwd, "branch", "feat/x");
  fs.mkdirSync(path.join(cwd, ".crs"));
  fs.writeFileSync(
    path.join(cwd, ".crs", "dock.json"),
    JSON.stringify({
      controls: [
        { id: "web", title: "Web", command: "vite --port $PORT", env: { A: "1" }, preview: true },
      ],
    }),
  );
  return cwd;
}

describe("POST /api/previews with a branch, local project (#3555)", () => {
  it("starts the dev server with the allocated PORT in its environment", async () => {
    const app = await buildApp();
    const cwd = makeRepo();
    const [project] = app.db
      .insert(projects)
      .values({ name: "local-preview", cwd, hostId: "local" })
      .returning()
      .all();

    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId: project.id, branch: "feat/x" },
    });

    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { branch: string; upstreamPort: number; sessionId: number };
    expect(body.branch).toBe("feat/x");
    expect(body.upstreamPort).toBeGreaterThan(0);

    // The dtach master's spawn carries the port the preview is bound to.
    const call = vi
      .mocked(spawnChildProcess)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const opts = call?.[2] as { env?: Record<string, string> };
    expect(opts.env?.PORT).toBe(String(body.upstreamPort));
    expect(opts.env?.A).toBe("1");

    // Persisted with the session, so a reattach replays the same PORT.
    const row = app.db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get();
    expect(JSON.parse(row!.env!)).toEqual({ A: "1", PORT: String(body.upstreamPort) });

    await app.close();
  });
});

// #3555 — the exemption is the branch preview's alone: a session's own `env`
// still may not set PORT, and the route's schema (additionalProperties: false)
// strips a `previewPort` a caller sends.
describe("POST /api/sessions and PORT (#3555)", () => {
  it("still refuses PORT in env with reserved-env-key, and creates no session", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", env: { PORT: "1" } },
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().message).toBe('env key "PORT" is reserved and cannot be set');
    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([]);

    await app.close();
  });

  it("ignores a previewPort in the body", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", previewPort: 4321 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().env ?? {}).not.toHaveProperty("PORT");
    const call = vi
      .mocked(spawnChildProcess)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    expect((call?.[2] as { env?: Record<string, string> }).env?.PORT).not.toBe("4321");

    await app.close();
  });
});
