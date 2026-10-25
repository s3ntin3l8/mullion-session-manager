import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as DemoModule from "../../scripts/demo/instance.mjs";

// Issue #1642: a server that fails to spawn must not orphan the other one or
// the scratch dir. These drive the real startDemo() with fake binaries.

const fixtures = mkdtempSync(path.join(tmpdir(), "mullion-demo-instance-test-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

const freePort = () =>
  new Promise<string>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(String(port)));
    });
  });

/** Live `sleep` processes (the fake servers) running inside `dir`. */
const processesIn = (dir: string) =>
  readdirSync("/proc")
    .filter((pid) => /^\d+$/.test(pid))
    .filter((pid) => {
      try {
        return (
          readlinkSync(`/proc/${pid}/cwd`).startsWith(`${dir}/`) &&
          readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("sleep")
        );
      } catch {
        return false; // gone, or not ours to inspect
      }
    });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const demoDirs = () =>
  new Set(readdirSync("/tmp").filter((name) => name.startsWith("mullion-demo-")));

/**
 * `startDemo`'s options, as the module really accepts them.
 *
 * TypeScript's inference over the .mjs source DROPS `bins`: a destructured
 * binding with no default in a JavaScript file gets no inferred type, so the
 * parameter type comes out as the four defaulted flags only. The module
 * really does take `bins` — it is the documented override hook every test
 * below drives — so the shape is restated here.
 */
type DemoBins = ReturnType<typeof DemoModule.demoBins>;
type DemoOptions = NonNullable<Parameters<typeof DemoModule.startDemo>[0]> & {
  bins?: DemoBins;
};

/**
 * Starts a demo and reports its own scratch dir (from its log line), so the
 * assertions never look at another demo running on the same host.
 */
function startCapturingDir(opts: DemoOptions) {
  let dir: string | undefined;
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const m = /^\[demo\] scratch dir (\S+)/.exec(String(args[0]));
    if (m) dir = m[1];
  });
  const started = demo.startDemo(opts).finally(() => log.mockRestore());
  started.catch(() => {});
  return { started, dir: () => dir };
}

const until = async (cond: () => boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
};

let demo: typeof DemoModule;
const realPath = process.env.PATH;
beforeAll(async () => {
  // Teardown asks systemd for the demo's session scopes. Tests must not reach
  // the host's user bus (CONTRIBUTING.md), so shadow systemctl with one that
  // reports no bus, which stopDemoScopes treats as "nothing to stop".
  const fakeBin = path.join(fixtures, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(
    path.join(fakeBin, "systemctl"),
    '#!/bin/sh\necho "Failed to connect to bus: No such file or directory" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${fakeBin}:${realPath}`;
  // The ports are read at import time, so pick free ones before importing:
  // a real `make demo` on this host must not make the test fail.
  process.env.DEMO_BACKEND_PORT = await freePort();
  process.env.DEMO_FRONTEND_PORT = await freePort();
  demo = await import("../../scripts/demo/instance.mjs");
});
afterAll(() => {
  process.env.PATH = realPath;
  delete process.env.DEMO_BACKEND_PORT;
  delete process.env.DEMO_FRONTEND_PORT;
});

describe("preflight", () => {
  it("names the missing frontend deps and how to install them", () => {
    const bins = demo.demoBins(path.join(fixtures, "no-such-repo"));
    expect(() => demo.preflight({ ...bins, tsx: process.execPath })).toThrow(
      /frontend\/node_modules\/\.bin\/vite.*npm --prefix frontend ci/,
    );
  });

  it("refuses before creating a scratch dir", async () => {
    const before = demoDirs();
    // Passed through a variable (not an inline literal) so the `bins`
    // override — which the .mjs's inferred type drops — is not rejected as
    // an excess property.
    const opts: DemoOptions = {
      quiet: true,
      bins: { tsx: process.execPath, vite: "/nonexistent/vite" },
    };
    await expect(demo.startDemo(opts)).rejects.toThrow(/npm --prefix frontend ci/);
    expect([...demoDirs()].filter((d) => !before.has(d))).toEqual([]);
  });
});

const writeScript = (name: string, body: string, mode: number) => {
  const file = path.join(fixtures, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode });
  return file;
};

describe("a server that fails to spawn", () => {
  it("tears down the started backend and removes the scratch dir", async () => {
    // Fake backend: stays up like a real server would.
    const tsx = writeScript("tsx", "exec sleep 60", 0o755);
    // Exists, so preflight passes, but is not executable: spawn fails with
    // EACCES, the same asynchronous 'error' as the ENOENT in the issue.
    const vite = writeScript("vite", "exit 0", 0o644);

    const run = startCapturingDir({ quiet: true, seed: false, bins: { tsx, vite } });
    await expect(run.started).rejects.toThrow(/frontend: could not run .*vite: EACCES/);
    const dir = run.dir();
    expect(dir).toMatch(/^\/tmp\/mullion-demo-/);
    expect(existsSync(dir!)).toBe(false);
    expect(processesIn(dir!)).toEqual([]);
  });

  it("removes the scratch dir even when no server ever started", async () => {
    const notExecutable = writeScript("not-executable", "exit 0", 0o644);
    const run = startCapturingDir({
      quiet: true,
      seed: false,
      bins: { tsx: notExecutable, vite: notExecutable },
    });
    await expect(run.started).rejects.toThrow(/backend: could not run .*EACCES/);
    expect(run.dir()).toMatch(/^\/tmp\/mullion-demo-/);
    expect(existsSync(run.dir()!)).toBe(false);
  });
});

describe("a signal during startup", () => {
  it("stops both servers and removes the scratch dir", async () => {
    // Both servers start but never answer HTTP, so startup stays in waitForHttp.
    // The backend runs inside the scratch dir; the frontend runs in frontend/,
    // so it records its pid instead.
    const tsx = writeScript("server", "exec sleep 60", 0o755);
    const vitePid = path.join(fixtures, "vite.pid");
    const vite = writeScript("vite-up", `echo $$ > ${vitePid}\nexec sleep 60`, 0o755);
    const before = process.listeners("SIGINT");
    const run = startCapturingDir({ quiet: true, seed: false, bins: { tsx, vite } });
    await until(
      () => run.dir() !== undefined && processesIn(run.dir()!).length === 1 && existsSync(vitePid),
    );
    const frontendPid = Number(readFileSync(vitePid, "utf8"));
    expect(isAlive(frontendPid)).toBe(true);

    // Call startDemo's own handler rather than signalling the test worker.
    const added = process.listeners("SIGINT").filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    added[0]("SIGINT");

    await expect(run.started).rejects.toThrow(/interrupted by SIGINT during startup/);
    expect(existsSync(run.dir()!)).toBe(false);
    expect(processesIn(run.dir()!)).toEqual([]);
    expect(isAlive(frontendPid)).toBe(false);
    expect(process.listeners("SIGINT")).toEqual(before);
  });
});
