import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDtachMasters, reapDtachMasters } from "./reap-dtach.js";

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

  it("returns nothing when procfs is absent", () => {
    expect(findDtachMasters("/x", "/no-such-proc")).toEqual([]);
  });
});
