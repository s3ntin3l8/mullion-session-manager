// Issue #2161 — the log the Windows updater writes to. A unit test with a mocked
// spawn (update-apply.test.ts) cannot see this one, and it cost a silent
// failure the first time the whole thing ran for real: a Git Bash that was
// handed an APPEND-mode file handle for stdout/stderr wrote nothing to it, and
// self-update.sh (`set -e`) simply ended at its first write — the status stuck
// at "downloading", the log empty, no error anywhere. So this runs a real,
// detached Git Bash against the descriptor openUpdateLog returns.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openUpdateLog } from "../../src/services/update-apply.js";
import { sessionShellOrNull } from "../../src/services/session-shell.js";

const BASH = process.platform === "win32" ? sessionShellOrNull() : null;

describe("openUpdateLog", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const tmpLog = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-log-"));
    dirs.push(dir);
    return path.join(dir, "logs", "update-1.2.3.log");
  };

  it("creates the logs directory and the log", () => {
    const log = tmpLog();
    fs.closeSync(openUpdateLog(log));
    expect(fs.readFileSync(log, "utf8")).toBe("");
  });

  it("keeps an earlier attempt's log as .1 instead of appending to it, and replaces an older .1", () => {
    const log = tmpLog();
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(`${log}.1`, "the attempt before last");
    fs.writeFileSync(log, "the last attempt");
    fs.closeSync(openUpdateLog(log));
    expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("the last attempt");
    expect(fs.readFileSync(log, "utf8")).toBe("");
  });

  it.runIf(BASH)(
    "lets a detached Git Bash write its stdout and stderr to the log it returns",
    async () => {
      const log = tmpLog();
      const fd = openUpdateLog(log);
      try {
        const child = spawn(BASH!, ["-l", "-c", "echo to-stdout; echo to-stderr >&2"], {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", fd, fd],
        });
        await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
      } finally {
        fs.closeSync(fd);
      }
      const text = fs.readFileSync(log, "utf8");
      expect(text).toContain("to-stdout");
      expect(text).toContain("to-stderr");
    },
    30_000,
  );
});
