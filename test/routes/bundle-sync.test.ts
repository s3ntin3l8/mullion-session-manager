import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { closeDb } from "../../src/db/client.js";
import { buildTestApp } from "../helpers/app.js";
import type * as AgentDetectModule from "../../src/services/agent-detect.js";

const tmpDb = path.join(os.tmpdir(), `bundle-sync-route-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

// Issue #1089 — POST /api/bundle-sync/remove's fan-out to every registered
// agent host (agent-bundle-state.ts's removeHostBundle, over
// RemoteHostClient). Mocked at the module boundary, same shape as
// test/services/host-files.test.ts's own mock of this module — nothing in
// this suite needs a real network call, only the dispatch/best-effort
// behavior.
const mockGetRemoteHostClient = vi.fn();
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: (...args: unknown[]) => mockGetRemoteHostClient(...args),
  HostRequestError: class extends Error {
    statusCode: number;
    constructor(hostId: string, statusCode: number, body: string) {
      super(`Host ${hostId} rejected the request: HTTP ${statusCode}${body ? ` — ${body}` : ""}`);
      this.name = "HostRequestError";
      this.statusCode = statusCode;
    }
  },
  HostUnreachableError: class extends Error {
    constructor(hostId: string, cause: unknown) {
      super(
        `Host ${hostId} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.name = "HostUnreachableError";
    }
  },
}));

// GET /api/bundle-sync/status calls getCachedAgents() under the hood
// (agent-detect.ts), which shells out to probe every known binary — faked
// directly at that module boundary (rather than child_process, like
// test/routes/agents.test.ts does) since this suite only needs to control
// its RESULT, not exercise the real probing mechanics agent-detect.test.ts
// already covers.
vi.mock("../../src/services/agent-detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentDetectModule>();
  return {
    ...actual,
    getCachedAgents: vi.fn(async () => [
      {
        id: "agent:claude",
        title: "claude",
        command: "claude",
        kind: "agent",
        available: true,
        path: "/usr/bin/claude",
        emits: [],
      },
      {
        id: "agent:codex",
        title: "codex",
        command: "codex",
        kind: "agent",
        available: true,
        path: "/usr/bin/codex",
        emits: [],
      },
      {
        id: "agent:agy",
        title: "agy",
        command: "agy",
        kind: "agent",
        available: true,
        path: "/usr/bin/agy",
        emits: [],
      },
      {
        id: "agent:opencode",
        title: "opencode",
        command: "opencode",
        kind: "agent",
        available: false,
        path: null,
        emits: [],
      },
    ]),
  };
});

// This whole suite exercises real filesystem paths derived from
// os.homedir() and MULLION_HOME — redirected to scratch directories for
// every test, same pattern as test/services/bundle-sync.test.ts.
const originalHome = process.env.HOME;
const originalMullionHome = process.env.MULLION_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

let homeDir: string;
let mullionHomeDir: string;

function bundleDir(): string {
  return path.join(mullionHomeDir, "current", "dist", "bundle");
}

function writeSkill(name: string): void {
  const dir = path.join(bundleDir(), "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "The ${name} skill."\n---\n\nBody for ${name}.\n`,
  );
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-sync-route-fakehome-"));
  mullionHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-sync-route-fakebundle-"));
  process.env.HOME = homeDir;
  process.env.MULLION_HOME = mullionHomeDir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  mockGetRemoteHostClient.mockReset();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
  else process.env.MULLION_HOME = originalMullionHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(mullionHomeDir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDb, { force: true });
  delete process.env.DATABASE_URL;
});

async function setInjectMullionBundle(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  value: boolean,
) {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/settings",
    payload: { sessions: { injectMullionBundle: value } },
  });
  expect(res.statusCode).toBe(200);
}

describe("GET /api/bundle-sync/status", () => {
  it("disabled: every CLI row reads 'disabled'", async () => {
    const app = await buildTestApp();
    await setInjectMullionBundle(app, false);

    const res = await app.inject({ method: "GET", url: "/api/bundle-sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.bundleHash).toBeNull();
    expect(body.clis).toHaveLength(4);
    for (const cli of body.clis) {
      expect(cli.skills.status).toBe("disabled");
      expect(cli.agents.status).toBe("disabled");
    }
  });

  it("all-synced: enabled with a fresh sync reports 'synced' for every CLI's skills", async () => {
    writeSkill("host");
    const app = await buildTestApp();
    await setInjectMullionBundle(app, true);

    const resyncRes = await app.inject({ method: "POST", url: "/api/bundle-sync/resync" });
    expect(resyncRes.statusCode).toBe(200);
    expect(resyncRes.json()).toEqual({ changed: true });

    const res = await app.inject({ method: "GET", url: "/api/bundle-sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(typeof body.bundleHash).toBe("string");
    for (const cli of body.clis) {
      expect(cli.skills.status).toBe("synced");
      expect(cli.skills.count).toBe(1);
    }
  });

  it("stale: a hand-deleted installed skill is reported as 'stale', not 'synced'", async () => {
    writeSkill("host");
    const app = await buildTestApp();
    await setInjectMullionBundle(app, true);
    await app.inject({ method: "POST", url: "/api/bundle-sync/resync" });

    const { resolveClaudeConfigDir } =
      await import("../../src/services/hook-adapters/claude-code.js");
    fs.rmSync(path.join(resolveClaudeConfigDir(), "skills", "mullion-host"), {
      recursive: true,
      force: true,
    });

    const res = await app.inject({ method: "GET", url: "/api/bundle-sync/status" });
    const body = res.json();
    const claude = body.clis.find((c: { cli: string }) => c.cli === "claude-code");
    expect(claude.skills.status).toBe("stale");
  });

  it("surfaces detected per CLI, matched from getCachedAgents' own ids", async () => {
    const app = await buildTestApp();
    await setInjectMullionBundle(app, true);
    const res = await app.inject({ method: "GET", url: "/api/bundle-sync/status" });
    const body = res.json();
    const byCli = Object.fromEntries(
      (body.clis as Array<{ cli: string; detected: boolean }>).map((c) => [c.cli, c.detected]),
    );
    expect(byCli["claude-code"]).toBe(true);
    expect(byCli.codex).toBe(true);
    expect(byCli.agy).toBe(true);
    expect(byCli.opencode).toBe(false);
  });
});

describe("POST /api/bundle-sync/resync", () => {
  it("409s with { error: 'disabled' } when sessions.injectMullionBundle is off", async () => {
    const app = await buildTestApp();
    await setInjectMullionBundle(app, false);

    const res = await app.inject({ method: "POST", url: "/api/bundle-sync/resync" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "disabled" });
  });

  it("re-syncs and reports changed:true on first run, changed:false once already synced", async () => {
    writeSkill("host");
    const app = await buildTestApp();
    await setInjectMullionBundle(app, true);

    const first = await app.inject({ method: "POST", url: "/api/bundle-sync/resync" });
    expect(first.json()).toEqual({ changed: true });

    const second = await app.inject({ method: "POST", url: "/api/bundle-sync/resync" });
    expect(second.json()).toEqual({ changed: false });
  });
});

describe("POST /api/bundle-sync/remove", () => {
  it("flips sessions.injectMullionBundle off and removes synced content", async () => {
    writeSkill("host");
    const app = await buildTestApp();
    await setInjectMullionBundle(app, true);
    await app.inject({ method: "POST", url: "/api/bundle-sync/resync" });

    const { resolveClaudeConfigDir } =
      await import("../../src/services/hook-adapters/claude-code.js");
    const claudeSkill = path.join(resolveClaudeConfigDir(), "skills", "mullion-host");
    expect(fs.existsSync(claudeSkill)).toBe(true);

    const res = await app.inject({ method: "POST", url: "/api/bundle-sync/remove" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settingDisabled).toBe(true);
    expect(body.removed).toBeGreaterThan(0);
    expect(fs.existsSync(claudeSkill)).toBe(false);

    const settingsRes = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settingsRes.json().sessions.injectMullionBundle).toBe(false);

    const statusRes = await app.inject({ method: "GET", url: "/api/bundle-sync/status" });
    expect(statusRes.json().enabled).toBe(false);
  });

  it("is a clean no-op with a zero result when nothing is installed", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/bundle-sync/remove" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 0, legacySwept: 0, settingDisabled: true });
  });

  // Issue #1089 — the fan-out to every registered agent host. Each test
  // deletes the host row it creates (host-registry.ts's deleteHost) — this
  // suite's DB (tmpDb, module scope) persists across every test in this
  // file, so a row left behind here would leak into later tests' own
  // fan-out expectations (and, first-run, break "never dispatches to the
  // local host" below if it happened to run after one of these).
  describe("fan-out to registered agent hosts", () => {
    it("calls removeAgentBundle on a registered agent host, and the primary's own removal still succeeds", async () => {
      const app = await buildTestApp();
      const { createHost, deleteHost } = await import("../../src/services/host-registry.js");
      const host = createHost(app, {
        name: "agent-1",
        baseUrl: "http://agent-1.example:4000",
        token: "tok",
      });
      const removeAgentBundleMock = vi.fn().mockResolvedValue({ removed: 2, legacySwept: 0 });
      mockGetRemoteHostClient.mockReturnValue({ removeAgentBundle: removeAgentBundleMock });

      try {
        const res = await app.inject({ method: "POST", url: "/api/bundle-sync/remove" });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ removed: 0, legacySwept: 0, settingDisabled: true });
        // Not `toHaveBeenCalledWith(app, host.id)` — a deep-equal match
        // against the full FastifyInstance (app) drags in live server/
        // socket getters that throw outside a real listening request.
        expect(mockGetRemoteHostClient).toHaveBeenCalledWith(expect.anything(), host.id);
        expect(removeAgentBundleMock).toHaveBeenCalledWith(true);
      } finally {
        deleteHost(app, host.id);
      }
    });

    it("an unreachable agent host is logged and skipped — never blocks the primary's own removal", async () => {
      writeSkill("host");
      const app = await buildTestApp();
      await setInjectMullionBundle(app, true);
      await app.inject({ method: "POST", url: "/api/bundle-sync/resync" });

      const { createHost, deleteHost } = await import("../../src/services/host-registry.js");
      const host = createHost(app, {
        name: "unreachable-agent",
        baseUrl: "http://nope.example:4000",
        token: "tok",
      });
      const { HostUnreachableError } = await import("../../src/services/remote-host-client.js");
      mockGetRemoteHostClient.mockReturnValue({
        removeAgentBundle: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError(host.id, new Error("timeout"))),
      });
      const warnSpy = vi.spyOn(app.log, "warn");

      try {
        const res = await app.inject({ method: "POST", url: "/api/bundle-sync/remove" });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.settingDisabled).toBe(true);
        expect(body.removed).toBeGreaterThan(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ hostId: host.id }),
          expect.stringContaining("could not reach agent host"),
        );
      } finally {
        deleteHost(app, host.id);
      }
    });

    it("never dispatches to the local host itself, only to remote registered agent hosts", async () => {
      const app = await buildTestApp();

      await app.inject({ method: "POST", url: "/api/bundle-sync/remove" });

      expect(mockGetRemoteHostClient).not.toHaveBeenCalled();
    });

    it("with TWO registered agent hosts, one unreachable does not prevent the other from being dispatched to", async () => {
      const app = await buildTestApp();
      const { createHost, deleteHost } = await import("../../src/services/host-registry.js");
      const badHost = createHost(app, {
        name: "bad-agent",
        baseUrl: "http://nope.example:4000",
        token: "tok",
      });
      const goodHost = createHost(app, {
        name: "good-agent",
        baseUrl: "http://good-agent.example:4000",
        token: "tok",
      });
      const { HostUnreachableError } = await import("../../src/services/remote-host-client.js");
      const removeAgentBundleMock = vi.fn().mockResolvedValue({ removed: 1, legacySwept: 0 });
      mockGetRemoteHostClient.mockImplementation((_app: unknown, hostId: string) => {
        if (hostId === badHost.id) {
          return {
            removeAgentBundle: vi
              .fn()
              .mockRejectedValue(new HostUnreachableError(badHost.id, new Error("timeout"))),
          };
        }
        return { removeAgentBundle: removeAgentBundleMock };
      });

      try {
        const res = await app.inject({ method: "POST", url: "/api/bundle-sync/remove" });

        expect(res.statusCode).toBe(200);
        expect(res.json().settingDisabled).toBe(true);
        // The unreachable host doesn't short-circuit the Promise.all — the
        // reachable one is still dispatched to, proving multi-host
        // isolation rather than just single-host best-effort.
        expect(removeAgentBundleMock).toHaveBeenCalledWith(true);
        expect(mockGetRemoteHostClient).toHaveBeenCalledWith(expect.anything(), badHost.id);
        expect(mockGetRemoteHostClient).toHaveBeenCalledWith(expect.anything(), goodHost.id);
      } finally {
        deleteHost(app, badHost.id);
        deleteHost(app, goodHost.id);
      }
    });
  });
});
