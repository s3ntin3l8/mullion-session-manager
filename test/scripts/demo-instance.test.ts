import {
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** Live `sleep` processes (the fake backend) whose cwd matches. */
const processesIn = (cwd: RegExp) =>
  readdirSync("/proc")
    .filter((pid) => /^\d+$/.test(pid))
    .filter((pid) => {
      try {
        return (
          cwd.test(readlinkSync(`/proc/${pid}/cwd`)) &&
          readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("sleep")
        );
      } catch {
        return false; // gone, or not ours to inspect
      }
    });

const demoDirs = () =>
  new Set(readdirSync("/tmp").filter((name) => name.startsWith("mullion-demo-")));

let demo: typeof DemoModule;
beforeAll(async () => {
  // The ports are read at import time, so pick free ones before importing:
  // a real `make demo` on this host must not make the test fail.
  process.env.DEMO_BACKEND_PORT = await freePort();
  process.env.DEMO_FRONTEND_PORT = await freePort();
  demo = await import("../../scripts/demo/instance.mjs");
});
afterAll(() => {
  delete process.env.DEMO_BACKEND_PORT;
  delete process.env.DEMO_FRONTEND_PORT;
});

describe("preflight", () => {
  it("names the missing frontend deps and how to install them", () => {
    const bins = demo.demoBins(path.join(fixtures, "no-such-repo"));
    expect(() => demo.preflight({ ...bins, tsx: process.execPath })).toThrow(
      /frontend\/node_modules\/\.bin\/vite.*cd frontend && npm ci.*make wt/,
    );
  });

  it("refuses before creating a scratch dir", async () => {
    const before = demoDirs();
    await expect(
      demo.startDemo({ quiet: true, bins: { tsx: process.execPath, vite: "/nonexistent/vite" } }),
    ).rejects.toThrow(/cd frontend && npm ci/);
    expect([...demoDirs()].filter((d) => !before.has(d))).toEqual([]);
  });
});

describe("a server that fails to spawn", () => {
  it("tears down the started backend and removes the scratch dir", async () => {
    // Fake backend: stays up like a real server would.
    const tsx = path.join(fixtures, "tsx");
    writeFileSync(tsx, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
    // Exists, so preflight passes, but is not executable: spawn fails with
    // EACCES, the same asynchronous 'error' as the ENOENT in the issue.
    const vite = path.join(fixtures, "vite");
    writeFileSync(vite, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

    const before = demoDirs();
    await expect(demo.startDemo({ quiet: true, seed: false, bins: { tsx, vite } })).rejects.toThrow(
      /frontend: could not run .*vite: EACCES/,
    );
    expect([...demoDirs()].filter((d) => !before.has(d))).toEqual([]);
    // The backend ran with its cwd in the scratch dir's run/; nothing may be
    // left running there.
    expect(processesIn(/^\/tmp\/mullion-demo-[^/]+\/run\b/)).toEqual([]);
  });

  it("removes the scratch dir even when no server ever started", async () => {
    const before = demoDirs();
    const notExecutable = path.join(fixtures, "not-executable");
    writeFileSync(notExecutable, "", { mode: 0o644 });
    await expect(
      demo.startDemo({
        quiet: true,
        seed: false,
        bins: { tsx: notExecutable, vite: notExecutable },
      }),
    ).rejects.toThrow(/backend: could not run .*EACCES/);
    expect([...demoDirs()].filter((d) => !before.has(d))).toEqual([]);
  });
});
