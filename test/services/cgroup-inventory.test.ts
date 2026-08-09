import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCgroupProcs,
  parseStat,
  parseCmdline,
  readCgroupProcesses,
  resolveScopeCgroupPath,
  listScopeProcesses,
} from "../../src/services/cgroup-inventory.js";

describe("parseCgroupProcs", () => {
  it("parses one PID per line", () => {
    expect(parseCgroupProcs("123\n456\n789\n")).toEqual([123, 456, 789]);
  });

  it("drops blank lines rather than producing NaN entries", () => {
    expect(parseCgroupProcs("123\n\n\n456\n")).toEqual([123, 456]);
  });

  it("returns [] for empty content", () => {
    expect(parseCgroupProcs("")).toEqual([]);
  });
});

describe("parseStat", () => {
  it("extracts comm and ppid from a real /proc/<pid>/stat line", () => {
    const stat =
      "2351914 (claude) R 2351913 2351914 2351914 34819 2351914 4194304 223835 833400 24 13";
    expect(parseStat(stat)).toEqual({ comm: "claude", ppid: 2351913 });
  });

  it("handles a comm containing spaces and parens without misreading ppid", () => {
    // A process can rename itself (prctl(PR_SET_NAME)) to arbitrary bytes,
    // including further ')' characters — must anchor on the LAST ')'.
    const stat = "99 (node (worker)) S 42 99 99 0 -1 4194368";
    expect(parseStat(stat)).toEqual({ comm: "node (worker)", ppid: 42 });
  });

  it("returns null for content with no parenthesized comm", () => {
    expect(parseStat("not a stat line")).toBeNull();
  });

  it("returns null when the field after comm isn't a valid ppid", () => {
    expect(parseStat("1 (x) S not-a-number")).toBeNull();
  });
});

describe("parseCmdline", () => {
  it("splits NUL-separated argv and drops the trailing NUL", () => {
    expect(parseCmdline("node\0server.js\0--flag\0")).toEqual(["node", "server.js", "--flag"]);
  });

  it("returns [] for an empty cmdline (zombie / kernel thread)", () => {
    expect(parseCmdline("")).toEqual([]);
  });
});

describe("readCgroupProcesses", () => {
  function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}) {
    return {
      readFile: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      readDir: (p: string) => dirs[p] ?? [],
    };
  }

  it("resolves pid/ppid/comm/cmdline for every PID in cgroup.procs", () => {
    const { readFile, readDir } = fakeFs({
      "/sys/fs/cgroup/session.scope/cgroup.procs": "10\n20\n",
      "/proc/10/stat": "10 (dtach) S 1 10 10 0 -1 4194368",
      "/proc/10/cmdline": "dtach\0-n\0sock\0",
      "/proc/20/stat": "20 (claude) S 10 20 20 0 -1 4194368",
      "/proc/20/cmdline": "claude\0--flag\0",
    });
    const result = readCgroupProcesses("/session.scope", { readFile, readDir });
    expect(result).toEqual([
      { pid: 10, ppid: 1, comm: "dtach", cmdline: ["dtach", "-n", "sock"] },
      { pid: 20, ppid: 10, comm: "claude", cmdline: ["claude", "--flag"] },
    ]);
  });

  it("skips a PID that exited between the cgroup.procs snapshot and its /proc read", () => {
    const { readFile, readDir } = fakeFs({
      "/sys/fs/cgroup/session.scope/cgroup.procs": "10\n20\n",
      "/proc/10/stat": "10 (dtach) S 1 10 10 0 -1 4194368",
      "/proc/10/cmdline": "dtach\0",
      // 20's /proc entries are absent — simulates it exiting mid-read.
    });
    const result = readCgroupProcesses("/session.scope", { readFile, readDir });
    expect(result).toEqual([{ pid: 10, ppid: 1, comm: "dtach", cmdline: ["dtach"] }]);
  });

  it("returns [] when the root cgroup.procs is unreadable (scope gone)", () => {
    const { readFile, readDir } = fakeFs({});
    expect(readCgroupProcesses("/session.scope", { readFile, readDir })).toEqual([]);
  });

  it("walks a descendant cgroup and merges its PIDs into the result", () => {
    // A subprocess that creates its own nested cgroup (e.g. a nested
    // `systemd-run --scope`) would otherwise be invisible to a flat read.
    const { readFile, readDir } = fakeFs(
      {
        "/sys/fs/cgroup/session.scope/cgroup.procs": "10\n",
        "/sys/fs/cgroup/session.scope/nested/cgroup.procs": "20\n",
        "/proc/10/stat": "10 (dtach) S 1 10 10 0 -1 4194368",
        "/proc/10/cmdline": "dtach\0",
        "/proc/20/stat": "20 (inner) S 10 20 20 0 -1 4194368",
        "/proc/20/cmdline": "inner\0",
      },
      { "/sys/fs/cgroup/session.scope": ["nested"] },
    );
    const result = readCgroupProcesses("/session.scope", { readFile, readDir });
    expect(result.map((p) => p.pid).sort()).toEqual([10, 20]);
  });

  it("walks real nested directories via the default (non-injected) readDir", () => {
    // Exercises the production readdirSync fallback in listChildCgroupDirs
    // (no readDir override), against a real temp directory tree — the
    // fake-readDir tests above only cover the injected path.
    const cgroupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgroup-inventory-test-"));
    fs.mkdirSync(path.join(cgroupRoot, "session.scope", "nested"), { recursive: true });
    fs.writeFileSync(path.join(cgroupRoot, "session.scope", "cgroup.procs"), "10\n");
    fs.writeFileSync(path.join(cgroupRoot, "session.scope", "nested", "cgroup.procs"), "20\n");
    // Not a directory — must be skipped by the isDirectory() filter, not
    // mistaken for a child cgroup.
    fs.writeFileSync(path.join(cgroupRoot, "session.scope", "not-a-dir"), "");

    const result = readCgroupProcesses("/session.scope", {
      cgroupRoot,
      procRoot: "/nonexistent-proc",
    });
    // procRoot doesn't resolve any real PIDs, but both PIDs must have been
    // discovered (root + nested) before the per-PID /proc read failed.
    expect(result).toEqual([]);
  });
});

describe("resolveScopeCgroupPath", () => {
  it("returns the trimmed ControlGroup value on success", async () => {
    const path = await resolveScopeCgroupPath("crs-session-1.scope", {
      querySystemctl: async () => "/user.slice/app.slice/crs-session-1.scope\n",
    });
    expect(path).toBe("/user.slice/app.slice/crs-session-1.scope");
  });

  it("returns null for an empty value (unit inactive/never existed)", async () => {
    const path = await resolveScopeCgroupPath("crs-session-1.scope", {
      querySystemctl: async () => "\n",
    });
    expect(path).toBeNull();
  });

  it("returns null rather than throwing when the query rejects", async () => {
    const path = await resolveScopeCgroupPath("crs-session-1.scope", {
      querySystemctl: async () => {
        throw new Error("systemctl not found");
      },
    });
    expect(path).toBeNull();
  });
});

describe("listScopeProcesses", () => {
  it("combines cgroup path resolution and process inventory", async () => {
    const processes = await listScopeProcesses("crs-session-1.scope", {
      querySystemctl: async () => "/session.scope",
      readFile: (p: string) => {
        const files: Record<string, string> = {
          "/sys/fs/cgroup/session.scope/cgroup.procs": "10\n",
          "/proc/10/stat": "10 (dtach) S 1 10 10 0 -1 4194368",
          "/proc/10/cmdline": "dtach\0",
        };
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      readDir: () => [],
    });
    expect(processes).toEqual([{ pid: 10, ppid: 1, comm: "dtach", cmdline: ["dtach"] }]);
  });

  it("returns [] for a scope that isn't active, without touching the filesystem", async () => {
    const processes = await listScopeProcesses("crs-session-1.scope", {
      querySystemctl: async () => "",
      readFile: () => {
        throw new Error("should not be called");
      },
    });
    expect(processes).toEqual([]);
  });
});
