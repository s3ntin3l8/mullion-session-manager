import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHIM_EXIT_CODE,
  describeScopeLeaks,
  findLeakedDtachMasters,
  findLeakedScopes,
  installSystemdRunShim,
  readBlockedLaunches,
} from "./scope-guard.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-guard-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("systemd-run shim (issue #2003)", () => {
  it("refuses to launch, exits with the distinctive code, and records the argv", () => {
    const guard = installSystemdRunShim(tmp());
    expect(readBlockedLaunches(guard)).toEqual([]);

    const res = spawnSync(
      "systemd-run",
      ["--user", "--scope", "-u", "crs-session-x-1", "--", "true"],
      {
        env: { ...process.env, PATH: `${guard.binDir}${path.delimiter}${process.env.PATH}` },
        encoding: "utf8",
      },
    );

    expect(res.status).toBe(SHIM_EXIT_CODE);
    expect(res.stderr).toContain("blocked by the vitest scope guard");
    expect(readBlockedLaunches(guard)).toEqual(["--user --scope -u crs-session-x-1 -- true"]);
  });

  it("is first on PATH for this very run (global-setup armed it)", () => {
    const first = (process.env.PATH ?? "").split(path.delimiter)[0] ?? "";
    expect(fs.existsSync(path.join(first, "systemd-run"))).toBe(true);
  });
});

describe("findLeakedScopes", () => {
  const root = "/tmp/mst-abc123";
  const listing = [
    `crs-session-aaaa1111-7.scope loaded active running /usr/bin/dtach -n ${root}/vitest-sessions-1-x/7.sock bash`,
    "crs-session-bbbb2222-9.scope loaded active running /usr/bin/dtach -n /home/u/sessions/9.sock bash",
    "",
  ].join("\n");

  it("returns only scopes whose socket lives under this run's temp root", () => {
    expect(findLeakedScopes(root, () => listing)).toEqual([
      expect.stringContaining("crs-session-aaaa1111-7.scope"),
    ]);
  });

  it("returns nothing for an empty listing (no user bus)", () => {
    expect(findLeakedScopes(root, () => "")).toEqual([]);
  });
});

describe("describeScopeLeaks", () => {
  it("is null when the run was clean", () => {
    expect(describeScopeLeaks([], [])).toBeNull();
  });

  it("names blocked launches and leaked scopes", () => {
    const msg = describeScopeLeaks(["-u crs-session-x-1"], ["crs-session-x-2.scope loaded"]);
    expect(msg).toContain("1 test launch(es) reached a real systemd-run");
    expect(msg).toContain("systemd-run -u crs-session-x-1");
    expect(msg).toContain("1 crs-session scope(s) left running");
    expect(msg).toContain("crs-session-x-2.scope");
  });
});

describe("findLeakedDtachMasters (issue #2112, macOS)", () => {
  const root = "/tmp/mst-AbC123";
  const ps = [
    "  101     1   101 /usr/bin/dtach -n /tmp/mst-AbC123/vitest-sessions-9/2.sock -Ez sh",
    "  102   101   101 sh",
    "  103     1   103 /usr/bin/dtach -n /tmp/mst-OTHER/vitest-sessions-1/3.sock -Ez sh",
    "  104     1   104 /usr/bin/dtach -n /Users/me/.mullion/sessions/1.sock -Ez sh",
  ].join("\n");

  it("returns only the masters whose socket lives under this run's root", () => {
    const rows = findLeakedDtachMasters(root, () => ps);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("/tmp/mst-AbC123/vitest-sessions-9/2.sock");
  });

  it("returns nothing when the process table can't be read", () => {
    expect(findLeakedDtachMasters(root, () => null)).toEqual([]);
  });

  it("describeScopeLeaks reports them", () => {
    expect(describeScopeLeaks([], [], ["101 dtach -n x"])).toContain("dtach master(s)");
    expect(describeScopeLeaks([], [], [])).toBeNull();
  });
});
