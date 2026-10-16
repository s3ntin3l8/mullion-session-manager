import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertDemoEnv,
  assertPortsFree,
  demoEnv,
  extractDtachSocketPath,
  instanceIdFor,
  ownsScope,
} from "../../scripts/demo/env.mjs";
import { stopDemoScopes } from "../../scripts/demo/instance.mjs";
import {
  deriveInstanceId,
  extractDtachSocketPath as backendExtractDtachSocketPath,
  scopeUnitName,
} from "../../src/services/session-process.js";

const demoDir = mkdtempSync(path.join(tmpdir(), "mullion-demo-test-"));
const bin = path.join(demoDir, "bin");
mkdirSync(bin);
writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
afterAll(() => rmSync(demoDir, { recursive: true, force: true }));

const PATH = `${bin}:/usr/bin`;

describe("demoEnv", () => {
  it("inherits only the allowlist from the parent", () => {
    const env = demoEnv(
      demoDir,
      { PATH },
      {
        PATH: "/usr/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
        MULLION_SOCKET_PATH: "/home/me/opt/mullion/data/sessions/mullion.sock",
        MULLION_HOOK_TOKEN: "t", // pragma: allowlist secret
        CLAUDE_CONFIG_DIR: "/home/me/.claude",
        DB_ENCRYPTION_KEY: "k", // pragma: allowlist secret
      },
    );
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(env.MULLION_SOCKET_PATH).toBeUndefined();
    expect(env.MULLION_HOOK_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.DB_ENCRYPTION_KEY).toBeUndefined();
    expect(env.HOME.startsWith(demoDir)).toBe(true);
    expect(assertDemoEnv(env, demoDir, { collect: true })).toEqual([]);
  });
});

describe("assertDemoEnv refuses a poisoned environment", () => {
  const base = demoEnv(demoDir, { PATH }, { PATH: "/usr/bin" });
  const problems = (vars: Record<string, string>, opts = {}) =>
    assertDemoEnv({ ...base, ...vars }, demoDir, { collect: true, ...opts });
  const refuses = (vars: Record<string, string>, opts = {}) =>
    expect(problems(vars, opts).length).toBeGreaterThan(0);

  it("the real control socket", () =>
    refuses({ MULLION_SOCKET_PATH: "/opt/mullion/data/sessions/mullion.sock" }));
  it("session identity leaking in from a hosting session", () =>
    refuses({ MULLION_SESSION_ID: "1602", MULLION_HOOK_SOCKET: "/x" }));
  it("a database outside the demo dir", () =>
    refuses({ DATABASE_URL: "file:/home/me/opt/mullion/data/app.db" }));
  it("a relative database path", () => refuses({ DATABASE_URL: "file:./data/app.db" }));
  it("the real sessions dir", () =>
    refuses({ SESSIONS_DIR: "/home/me/opt/mullion/data/sessions" }));
  it("the shared project config dir", () => refuses({ CRS_CONFIG_DIR: "/home/me/.config/crs" }));
  it("real projects", () => refuses({ PROJECTS_ROOTS: "/home/me/projects" }));
  it("agent config homes", () => refuses({ CLAUDE_CONFIG_DIR: path.join(demoDir, "c") }));
  it("secrets", () => refuses({ DB_ENCRYPTION_KEY: "k", MULLION_AGENT_TOKEN: "t" })); // pragma: allowlist secret
  it("devices or the browser", () => refuses({ DEVICE_ENABLED: "true" }));
  it("a PATH without the docker shim first", () => refuses({ PATH: "/usr/bin" }));
  it("a SESSIONS_DIR long enough for the backend to relocate it", () =>
    refuses({ SESSIONS_DIR: path.join(demoDir, "x".repeat(100)) }));
  it("a working directory holding a .env", () => {
    const cwd = mkdtempSync(path.join(demoDir, "cwd-"));
    writeFileSync(path.join(cwd, ".env"), "PROJECTS_ROOTS=/home/me/projects\n");
    refuses({}, { cwd });
  });

  it("reports one problem per offending key", () => {
    expect(problems({ MULLION_SOCKET_PATH: "/opt/mullion/data/sessions/mullion.sock" })).toEqual([
      "MULLION_SOCKET_PATH must not reach the demo",
    ]);
  });

  it("throws unless collecting", () => {
    expect(() => assertDemoEnv({ ...base, MULLION_SOCKET_PATH: "/x" }, demoDir)).toThrow(/refused/);
  });

  it("accepts the demo's own settings", () => {
    expect(
      problems({
        DATABASE_URL: `file:${path.join(demoDir, "app.db")}`,
        SESSIONS_DIR: path.join(demoDir, "s"),
        CRS_CONFIG_DIR: path.join(demoDir, "crs"),
        PROJECTS_ROOTS: path.join(demoDir, "projects"),
        MULLION_TRUST_GATEWAY: "true",
        PORT: "3956",
      }),
    ).toEqual([]);
  });
});

describe("instanceIdFor", () => {
  it("matches the backend's own scope namespace, so teardown stops only demo scopes", () => {
    const sessionsDir = path.join(demoDir, "s");
    const id = instanceIdFor(sessionsDir);
    expect(id).toBe(deriveInstanceId(sessionsDir));
    expect(scopeUnitName(id, "7")).toBe(`crs-session-${id}-7`);
    expect(instanceIdFor("/home/me/opt/mullion/data/sessions")).not.toBe(id);
  });
});

describe("scope ownership", () => {
  const sessionsDir = path.join(demoDir, "s");
  const describeScope = (socket: string) =>
    `Mullion session 7: /usr/bin/dtach -n ${socket} -z /bin/bash -l`;

  it("parses descriptions exactly like the backend", () => {
    for (const description of [
      describeScope(path.join(sessionsDir, "7.sock")),
      `x dtach -n "/tmp/with space/7.sock" -z y`,
      `x dtach -n '/tmp/single/7.sock' -z y`,
      "no socket here",
      "",
    ])
      expect(extractDtachSocketPath(description)).toBe(backendExtractDtachSocketPath(description));
  });

  it("owns a scope whose socket sits directly in SESSIONS_DIR", () => {
    expect(ownsScope(describeScope(path.join(sessionsDir, "7.sock")), sessionsDir)).toBe(true);
  });

  it("does not own a scope whose socket is elsewhere, or unparseable", () => {
    const real = "/home/me/opt/mullion/data/sessions";
    expect(ownsScope(describeScope(path.join(real, "7.sock")), sessionsDir)).toBe(false);
    expect(ownsScope(describeScope(path.join(sessionsDir, "sub", "7.sock")), sessionsDir)).toBe(
      false,
    );
    expect(ownsScope(describeScope(`${sessionsDir}-other/7.sock`), sessionsDir)).toBe(false);
    expect(ownsScope("not a dtach scope", sessionsDir)).toBe(false);
  });
});

describe("stopDemoScopes", () => {
  const sessionsDir = path.join(demoDir, "s");
  const id = instanceIdFor(sessionsDir);
  const realSessions = "/home/me/opt/mullion/data/sessions";
  const own = `crs-session-${id}-1`;
  const collision = `crs-session-${id}-2`; // our name prefix, a real instance's socket
  const real = `crs-session-${instanceIdFor(realSessions)}-3`;
  const unreadable = `crs-session-${id}-4`;
  const descriptions: Record<string, string> = {
    [own]: `dtach -n ${path.join(sessionsDir, "1.sock")} -z bash\n`,
    [collision]: `dtach -n ${path.join(realSessions, "2.sock")} -z bash\n`,
    [real]: `dtach -n ${path.join(realSessions, "3.sock")} -z bash\n`,
    [unreadable]: "something else\n",
  };
  const fakeSystemctl = (
    overrides: Record<string, () => never> = {},
    units = [own, collision, real],
  ) => {
    const stopped: string[] = [];
    const run = async (args: string[]) => {
      const [verb, unit] = args;
      if (overrides[verb]) overrides[verb]();
      if (verb === "show-environment") return { stdout: "" };
      if (verb === "list-units")
        return { stdout: units.map((u) => `${u} loaded active running x\n`).join("") };
      if (verb === "show") return { stdout: descriptions[unit] };
      stopped.push(unit);
      return { stdout: "" };
    };
    return { run, stopped };
  };
  const fail =
    (message: string, extra: object = {}) =>
    () => {
      throw Object.assign(new Error(message), extra);
    };

  it("stops only scopes whose socket is in its SESSIONS_DIR", async () => {
    const { run, stopped } = fakeSystemctl();
    expect(await stopDemoScopes(id, sessionsDir, run)).toEqual([]);
    expect(stopped).toEqual([own]);
  });

  it("treats a missing systemctl as nothing to stop", async () => {
    const { run, stopped } = fakeSystemctl({
      "show-environment": fail("spawn systemctl ENOENT", { code: "ENOENT" }),
    });
    expect(await stopDemoScopes(id, sessionsDir, run)).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it("treats systemctl without a user bus as nothing to stop", async () => {
    const { run } = fakeSystemctl({
      "show-environment": fail("Failed to connect to bus: No such file or directory", { code: 1 }),
    });
    expect(await stopDemoScopes(id, sessionsDir, run)).toEqual([]);
  });

  it("reports a failed listing when the bus is up", async () => {
    const { run } = fakeSystemctl({ "list-units": fail("Connection timed out", { code: 1 }) });
    expect(await stopDemoScopes(id, sessionsDir, run)).toEqual(["crs-session-*"]);
  });

  it("reports a failed stop", async () => {
    const { run } = fakeSystemctl({ stop: fail("Access denied", { stderr: "Access denied" }) });
    expect(await stopDemoScopes(id, sessionsDir, run)).toEqual([own]);
  });

  it("reports, but does not stop, a unit in its namespace it cannot verify", async () => {
    const { run, stopped } = fakeSystemctl({}, [own, unreadable]);
    expect(await stopDemoScopes(id, sessionsDir, run)).toEqual([unreadable]);
    expect(stopped).toEqual([own]);
  });
});

describe("assertPortsFree", () => {
  it("rejects a port that is already listening", async () => {
    const server = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as net.AddressInfo;
    await expect(assertPortsFree([port])).rejects.toThrow(/already in use/);
    server.close();
  });
});
