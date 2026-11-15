import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// `pkill -f "dist/server.js"` from another project's agent once SIGTERMed
// Mullion because its command line was the generic `node dist/server.js`.
// src/process-title.ts (first import of src/server.ts) renames the process;
// /proc/<pid>/cmdline is what `pgrep -f` / `pkill -f` match against.
describe("process title (in-process)", () => {
  it("sets process.title to mullion-server on import", async () => {
    const original = process.title;
    try {
      process.title = "node";
      await import("../src/process-title.js");
      expect(process.title).toBe("mullion-server");
    } finally {
      process.title = original;
    }
  });
});

describe.skipIf(process.platform !== "linux")("process title", () => {
  it("replaces the generic server.js command line with mullion-server", async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'await import("./src/process-title.ts"); setInterval(() => {}, 1000); console.log("ready")',
        // Dummy trailing argument: the initial command line contains
        // "dist/server.js", so the assertions below prove it was overwritten.
        "dist/server.js",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
        child.stdout.once("data", () => resolve());
      });
      const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8").replace(/\0/g, " ");
      expect(cmdline).toContain("mullion-server");
      expect(cmdline).not.toContain("dist/server.js");
      expect(cmdline).not.toContain("server.js");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
