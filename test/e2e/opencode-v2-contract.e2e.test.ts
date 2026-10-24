// Contract smoke test for the opencode v2 facts Mullion's integration depends
// on (see src/services/hook-adapters/opencode.ts's header): a CI guard so an
// opencode release that changes any of them fails here, loudly, instead of
// silently breaking hosted opencode sessions.
//
//  - `--standalone` exists on the default command (without it the TUI
//    attaches to the user's shared background service and the per-session
//    MULLION_* env / config content leak across sessions);
//  - `OPENCODE_CONFIG_CONTENT` layers ALONGSIDE the user's own config instead
//    of replacing it (their MCP servers and permission rules survive);
//  - a plugin DIRECTORY (`server.js`, `export default { id, setup }`) is
//    accepted and actually receives events — exercised with Mullion's real
//    src/hooks/opencode-plugin.js against a real unix-socket hook server;
//  - the `session export/import` subcommands used by promote exist.
//
// Everything runs in an isolated sandbox (XDG_* dirs + a private service
// port) and stops the background service it spawned, so it can never touch
// or attach to a developer's real opencode service. No model calls.
//
// Pinned to opencode 2.0.29 (see test/e2e/opencode/package.json). When
// bumping, re-verify these behaviours BEFORE moving the pin.
//
// Skipped gracefully if the `opencode` binary is not on PATH (so developers
// without opencode installed can still run `make test-e2e`). CI installs the
// pinned CLI explicitly — see .github/workflows/ci-cd.yml.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import { opencodeVersionWarning } from "../../src/services/hook-adapters/opencode.js";

const PINNED_OPENCODE_VERSION = "2.0.29";
const PLUGIN_SOURCE = path.resolve(import.meta.dirname, "../../src/hooks/opencode-plugin.js");

/** The slice of one `opencode debug config` document these assertions read. */
interface ConfigDoc {
  mcp?: { servers?: Record<string, unknown> };
  permissions?: Array<{ action: string; resource: string; effect: string }>;
  plugins?: string[];
  skills?: string[];
  agents?: {
    title?: { model?: unknown };
    reviewer?: Record<string, unknown>;
    build?: { permissions?: Array<{ action: string; resource: string; effect: string }> };
  };
}

function opencodeVersion(): string | null {
  try {
    return execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const version = opencodeVersion();
const describeIfOpencode = version === null ? describe.skip : describe;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describeIfOpencode("opencode v2 contract (Mullion's integration assumptions)", () => {
  let root: string;
  let projectDir: string;
  let env: NodeJS.ProcessEnv;

  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}): string =>
    execFileSync("opencode", args, {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, ...extraEnv },
      timeout: 60_000,
    });

  const stopService = () => {
    try {
      run(["service", "stop"]);
    } catch {
      // not running — fine
    }
  };

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "mullion-oc-e2e-"));
    projectDir = path.join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(path.join(root, "state"));
    mkdirSync(path.join(root, "data"));
    mkdirSync(path.join(root, "config", "opencode"), { recursive: true });
    // gitEnv(): a GIT_DIR leaked from an outer git hook would make `git init`
    // reinitialize *that* repo instead of this sandbox (issue #1602).
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir, env: gitEnv() });

    // Strip any ambient Mullion/opencode env so the resolved config is this
    // sandbox's alone, and isolate every XDG dir.
    env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(MULLION_|OPENCODE_)/.test(k)),
    );
    Object.assign(env, {
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
    });
    // A private service port: the default one may already be held by a
    // developer's own opencode service.
    run(["service", "set", "port", String(await freePort())]);
  });

  afterEach(() => {
    stopService();
  });

  afterAll(() => {
    stopService();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs against an opencode at least as new as the pinned version", () => {
    // The PINNED version is what these behaviors were verified against, but
    // the assertions below are about behavior, not an exact build: a
    // developer running `make test-e2e` with a NEWER opencode on PATH (the
    // pinned one is only installed by CI) must not be locked out by an exact
    // string match. A version OLDER than the pin is a different story — it
    // predates the v2 plugin API entirely, and the adapter refuses to launch
    // it.
    //
    // The comparison itself lives in ONE place — the adapter's own
    // minimum-version gate (`opencodeVersionWarning`, the same 2.0.29 tuple
    // compare `GET /api/agents` reports a warning from) — so this e2e gate
    // cannot drift away from the version the adapter actually supports.
    expect(
      opencodeVersionWarning(version),
      `opencode ${version} is older than the pinned ${PINNED_OPENCODE_VERSION}`,
    ).toBeNull();
  });

  it("offers --standalone on the default command, and session export/import subcommands", () => {
    expect(run(["--help"])).toContain("--standalone");
    const sessionHelp = run(["session", "--help"]);
    expect(sessionHelp).toContain("export");
    expect(sessionHelp).toContain("import");
  });

  it("layers OPENCODE_CONFIG_CONTENT alongside the user's own config instead of replacing it", () => {
    writeFileSync(
      path.join(root, "config", "opencode", "opencode.json"),
      JSON.stringify({
        mcp: { "user-mcp": { type: "remote", enabled: true, url: "https://example.invalid/mcp" } },
        permission: { skill: { "user-skill": "ask" } },
      }),
    );
    const pluginDir = path.join(root, "plugin");
    const sources = JSON.parse(
      run(["debug", "config"], {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          mcp: {
            mullion: {
              type: "local",
              command: ["node", "mcp.mjs"],
              environment: {},
              enabled: true,
            },
          },
          plugins: [pluginDir],
          skills: ["/some/skills"],
          agents: {
            title: { model: "anthropic/claude-haiku-5-5" },
            // the inline reviewer-agent shape (deriveOpenCodeReviewerAgentConfig)
            // — with the model a project's reviewer names through its
            // `opencode-model:` frontmatter key (issue #1731).
            reviewer: {
              description: "d",
              mode: "subagent",
              system: "be careful",
              model: "anthropic/claude-sonnet-4-5",
            },
          },
          // The shape the adapter writes for an unattended Task Master worker.
          permission: { skill: { brainstorming: "deny" } },
        }),
      }),
    ) as Array<{ type: string; info?: ConfigDoc }>;
    const docs = sources.filter((s) => s.type === "document" && s.info).map((s) => s.info!);

    // The user's own MCP server and Mullion's both load…
    expect(docs.some((d) => d.mcp?.servers?.["user-mcp"])).toBe(true);
    expect(docs.some((d) => d.mcp?.servers?.mullion)).toBe(true);
    // …and so do both sets of permission rules (1.x `permission.skill` is
    // normalized to `{ action: "skill", resource, effect }` rules).
    const rules = docs.flatMap((d) => d.permissions ?? []);
    expect(rules).toContainEqual({ action: "skill", resource: "user-skill", effect: "ask" });
    expect(rules).toContainEqual({ action: "skill", resource: "brainstorming", effect: "deny" });
    // The v2 spellings Mullion emits are recognised (not silently dropped).
    const content = docs.find((d) => d.plugins);
    expect(content?.plugins).toEqual([pluginDir]);
    expect(content?.skills).toEqual(["/some/skills"]);
    expect(content?.agents?.title?.model).toBeDefined();
    // the inline reviewer agent survives schema decoding with all three fields
    expect(content?.agents?.reviewer).toMatchObject({
      description: "d",
      mode: "subagent",
      system: "be careful",
    });
    // Issue #1731 — and so does its MODEL. This is the assertion that
    // matters: opencode's own config loader normalizes `provider/model` to
    // `{providerID, model}`, so a project reviewer's `opencode-model:` key
    // survives opencode's schema decode rather than being dropped on the
    // way in. Verified live against the installed opencode 2.1.3.
    expect(content?.agents?.reviewer?.model).toEqual({
      providerID: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  // Issue #1595. v2 evaluates a skill rule by `findLast` over: every document's
  // top-level permissions (in document order), THEN each agent's own
  // `agents.<id>.permissions`. So a user's agent-level allow outranks any
  // top-level deny — Task Master's worker denies are therefore repeated at
  // agent level in a LATER document (OPENCODE_CONFIG_CONTENT). A live model
  // run confirmed the outcome (the skill loads with only the top-level deny,
  // is unavailable with both); this pins the layering that makes it so.
  it("loads Mullion's agent-level skill denies in a later document than the user's agent-level allow", () => {
    writeFileSync(
      path.join(root, "config", "opencode", "opencode.json"),
      JSON.stringify({
        permission: { skill: { "writing-plans": "allow" } },
        agent: { build: { permission: { skill: { brainstorming: "allow" } } } },
      }),
    );
    const deny = { action: "skill", resource: "brainstorming", effect: "deny" };
    const sources = JSON.parse(
      run(["debug", "config"], {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { skill: { brainstorming: "deny", "writing-plans": "deny" } },
          agents: { build: { permissions: [deny] } },
        }),
      }),
    ) as Array<{ type: string; info?: ConfigDoc }>;
    const docs = sources.filter((s) => s.type === "document" && s.info).map((s) => s.info!);

    const userIdx = docs.findIndex((d) =>
      d.agents?.build?.permissions?.some(
        (r) => r.resource === "brainstorming" && r.effect === "allow",
      ),
    );
    const contentIdx = docs.findIndex((d) =>
      d.agents?.build?.permissions?.some(
        (r) => r.resource === "brainstorming" && r.effect === "deny",
      ),
    );
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(contentIdx).toBeGreaterThan(userIdx);
  });

  it("loads Mullion's plugin directory and delivers events to it (real plugin, real hook socket)", async () => {
    const pluginDir = path.join(root, "mullion-plugin");
    mkdirSync(pluginDir);
    copyFileSync(PLUGIN_SOURCE, path.join(pluginDir, "server.js"));

    const lines: string[] = [];
    const sockets: net.Socket[] = [];
    const socketPath = path.join(root, "hooks.sock");
    const server = net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        lines.push(...parts);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      run(["debug", "agents"], {
        MULLION_HOOK_SOCKET: socketPath,
        MULLION_HOOK_TOKEN: "e2e-token",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [pluginDir] }),
      });

      // `setup` ran (the loader accepted `export default { id, setup }`), it
      // subscribed to the event stream, and opencode's own startup
      // vcs.branch.updated reached the hook socket with the SESSION's
      // directory — not the shared server's cwd.
      const deadline = Date.now() + 20_000;
      while (!lines.some((l) => l.includes('"git_branch"')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const messages = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(messages[0]).toEqual({ token: "e2e-token" });
      expect(messages).toContainEqual({ kind: "git_branch", branch: "main" });
      expect(messages).toContainEqual({ kind: "cwd_changed", cwd: realpathSync(projectDir) });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
