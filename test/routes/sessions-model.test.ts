// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  createProject,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import { spawn as spawnChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { sessions } from "../../src/db/schema.js";
// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/helpers/pty-manager-harness.ts,
// so these files exercise the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
//
// Each spawned fake PTY's onData listener array is captured here (not just
// created and discarded) so a scrollback-identity test can push real,
// distinguishable output through a specific session's PTY after the fact —
// see the "returns the base64-encoded scrollback buffer" test in test/routes/sessions-read.test.ts.
// `ptyMock.spawnedPtys[n].emitData(...)` (mock-pty.ts's listener-capturing
// variant) replaces the pre-split file's hand-rolled `fakePtyListeners` array.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

// Issue #1733 — the agent's own argv reaches the dtach MASTER's spawn (the
// child_process one), not the attach client's node-pty spawn, so the mock's
// calls have to be reachable from the test.
vi.mock("node:child_process", async (importOriginal) => mockSpawnModule(await importOriginal()));

// Issue #271 follow-up — the opencode session transfer's own subprocess
// calls would otherwise hang; see mockSpawnModule's and opencodeTransferMock's
// doc comments in test/helpers/sessions-routes.ts.
vi.mock("../../src/services/opencode-session-transfer.js", () => opencodeTransferMock());

const { buildApp } = await import("../../src/app.js");

// This suite's own database, reset between tests — no test in this file can
// see another's rows, and no mock state leaks from one test into the next
// (see test/helpers/sessions-routes.ts).
setupSessionsRouteLifecycle("model");

describe("sessions route: explicit model validation", () => {
  // Issue #1423 — an explicit, caller-supplied model/smallModel used to
  // reach argv (for claude-code/codex/agy) or OPENCODE_CONFIG_CONTENT (for
  // opencode) with no validation at all — only shell-quoted. This is
  // reachable from spawn_child_session (MCP) and the control socket, not
  // just this REST route directly.
  describe("explicit model validation (issue #1423)", () => {
    it("rejects a flag-injection attempt as an explicit model for a Claude Code command", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude", model: "--dangerously-skip-permissions" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/model/i);

      // No session row was created for the rejected request.
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      expect(list.json()).toEqual([]);

      await app.close();
    });

    it("accepts a valid opusplan model for Claude Code and lands it as --model in argv", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude", model: "opusplan" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().model).toBe("opusplan");

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toContain("--model 'opusplan'");

      await app.close();
    });

    it("rejects an invalid explicit model for a Codex command", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "codex", model: "a b" },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("rejects an opencode model that isn't provider/model-shaped", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode", model: "sonnet" },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("rejects an opencode smallModel that is provider/model-shaped but still shell-hostile", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode", smallModel: "-x/$(y)" },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("drops (does not store or reject) a model/smallModel sent for a bash command", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", model: "anything", smallModel: "anything" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().model).toBeNull();
      expect(res.json().smallModel).toBeNull();

      await app.close();
    });

    it("keeps a valid smallModel for a Claude Code command and rejects an unsafe one", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const ok = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "claude",
          model: "sonnet",
          smallModel: "claude-haiku-5-5",
        },
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().model).toBe("sonnet");
      expect(ok.json().smallModel).toBe("claude-haiku-5-5");

      const bad = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude", smallModel: "--dangerously-skip-permissions" },
      });
      expect(bad.statusCode).toBe(400);

      // Issue #2032 — an alias would be exported as ANTHROPIC_DEFAULT_HAIKU_MODEL,
      // which the `haiku` alias itself resolves to, so it is rejected outright…
      const alias = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude", smallModel: "haiku" },
      });
      expect(alias.statusCode).toBe(400);
      expect(alias.json().message).toContain("full model id");
      // …while the same alias is still fine as the main model.
      const aliasMain = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude", model: "haiku" },
      });
      expect(aliasMain.statusCode).toBe(201);

      await app.close();
    });

    it("drops smallModel sent alongside a valid model for a Codex command", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "codex", model: "gpt-5", smallModel: "irrelevant here" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().model).toBe("gpt-5");
      expect(res.json().smallModel).toBeNull();

      await app.close();
    });

    it("falls through to the settings default when a parent session's stored opencode model is invalid", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const parentCreated = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode" },
      });
      const parentId = parentCreated.json().id as number;
      // Simulate a value written by an older backend build that pre-dates
      // this validation, bypassing the route's own checks entirely.
      app.db.update(sessions).set({ model: "-x/$(y)" }).where(eq(sessions.id, parentId)).run();

      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { opencode: { implementerModel: "openrouter/minimax-m3" } },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().model).toBe("openrouter/minimax-m3");

      await app.close();
    });

    it("falls through to the settings default when a parent session's stored opencode smallModel is invalid", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);

      const parentCreated = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode" },
      });
      const parentId = parentCreated.json().id as number;
      app.db.update(sessions).set({ smallModel: "sonnet" }).where(eq(sessions.id, parentId)).run();

      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { opencode: { defaultSmallModel: "opencode-go/cheap" } },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode", parentSessionId: parentId },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().smallModel).toBe("opencode-go/cheap");

      await app.close();
    });
  });
});
