import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { closeDb } from "../../src/db/client.js";
import { buildTestApp } from "../helpers/app.js";
import type * as AgentDetectModule from "../../src/services/agent-detect.js";

const tmpDb = path.join(os.tmpdir(), `bundle-sync-route-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

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
});
