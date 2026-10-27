import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dtachMastersFromPs, findDtachMasters, reapDtachMasters } from "./reap-dtach.js";

describe("reap-dtach", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    child?.kill("SIGKILL");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds and signals a process whose argv0 is dtach and names a socket under the dir", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reap-dtach-"));
    const fake = path.join(dir, "dtach");
    // exec -a keeps argv[0] = ".../dtach" so the cmdline matches a real master.
    child = spawn("bash", ["-c", `exec -a ${fake} bash -c "sleep 30; :" -n ${dir}/1.sock`], {
      stdio: "ignore",
    });
    const exited = new Promise((r) => child!.once("exit", r));
    await new Promise((r) => setTimeout(r, 200));
    expect(findDtachMasters(dir)).toContain(child.pid);
    expect(findDtachMasters("/nonexistent-dir")).toEqual([]);
    expect(reapDtachMasters(dir)).toBeGreaterThanOrEqual(1);
    await exited;
  });

  it("returns nothing when procfs is absent and the process table matches nothing", () => {
    expect(findDtachMasters("/x", "/no-such-proc", () => "  1  0  1 init\n")).toEqual([]);
  });

  it("returns nothing when procfs is absent and the process table can't be read", () => {
    expect(findDtachMasters("/x", "/no-such-proc", () => null)).toEqual([]);
  });

  it("falls back to the process table when procfs is absent", () => {
    const ps = "  10  1  10 /usr/bin/dtach -n /x/1.sock zsh\n";
    expect(findDtachMasters("/x", "/no-such-proc", () => ps)).toEqual(
      process.platform === "win32" ? [] : [10],
    );
  });

  it("reads the process table once per reap", () => {
    let reads = 0;
    reapDtachMasters("/x", "/no-such-proc", () => {
      reads++;
      return null;
    });
    expect(reads).toBe(process.platform === "win32" ? 0 : 1);
  });
});

describe("dtachMastersFromPs (macOS, no procfs)", () => {
  const ps = [
    "  10     1  10 /usr/local/bin/dtach -n /tmp/mst-X/vitest-sessions-1/2.sock -Ez zsh",
    "  11    10  10 zsh",
    "  12     1  12 dtach -n /tmp/mst-Y/other.sock -Ez zsh",
    "  13     1  13 vim /tmp/mst-X/vitest-sessions-1/notes",
  ].join("\n");

  it("finds the master under the dir and its direct children, and nothing else", () => {
    expect(dtachMastersFromPs(ps, "/tmp/mst-X")).toEqual({ masters: [10], children: [11] });
  });

  it("is empty when nothing matches", () => {
    expect(dtachMastersFromPs(ps, "/tmp/nope")).toEqual({ masters: [], children: [] });
  });
});
