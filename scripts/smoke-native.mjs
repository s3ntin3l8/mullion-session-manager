#!/usr/bin/env node
// Issue #2066 — prove both native modules actually LOAD on this host, not just
// that `npm ci` exited 0. The Windows CI job runs it right after a plain
// `npm ci` on a runner with no reason to have Visual Studio's C++ workload in
// play, so a green run means a Windows install needs no build tools.
//
// better-sqlite3: package.json's `allowScripts` denies its install script, so
// npm never runs the implicit `node-gyp rebuild` (which, on Windows, fails
// looking for Visual Studio before gyp ever notices the prebuild) and the
// package loads the N-API prebuild it ships. It resolves that binding LAZILY,
// in the Database constructor — a bare require() would prove nothing — so this
// opens an in-memory DB and runs a query.
//
// node-pty: spawns a real pseudo-terminal (ConPTY on Windows) and waits for
// the child's output and exit.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MARKER = "mullion-native-smoke";
const PTY_TIMEOUT_MS = 20_000;

function smokeSqlite() {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try {
    const { v } = db.prepare("select sqlite_version() as v").get();
    console.log(`better-sqlite3: ok (SQLite ${v})`);
  } finally {
    db.close();
  }
}

function smokePty() {
  const pty = require("node-pty");
  const [file, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/d", "/c", `echo ${MARKER}`]]
      : ["/bin/sh", ["-c", `echo ${MARKER}`]];
  return new Promise((resolve, reject) => {
    let output = "";
    const term = pty.spawn(file, args, {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    const timer = setTimeout(() => {
      term.kill();
      reject(
        new Error(
          `node-pty: no exit within ${PTY_TIMEOUT_MS}ms (output so far: ${JSON.stringify(output)})`,
        ),
      );
    }, PTY_TIMEOUT_MS);
    term.onData((d) => {
      output += d;
    });
    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 && output.includes(MARKER)) {
        console.log(`node-pty: ok (${file} exited 0)`);
        resolve();
      } else {
        reject(new Error(`node-pty: ${file} exited ${exitCode}, output ${JSON.stringify(output)}`));
      }
    });
  });
}

/**
 * Exit explicitly — on Windows node-pty's ConPTY machinery keeps the event
 * loop alive after the child has exited, so the script would otherwise never
 * end — but only once stdout and stderr have flushed: when they are pipes
 * (CI) their writes are asynchronous, and a bare process.exit() could drop
 * the very lines this script exists to print. Writes complete in order, so
 * an empty write's callback means everything before it is out.
 */
function exitFlushed(code) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

try {
  smokeSqlite();
  await smokePty();
  exitFlushed(0);
} catch (err) {
  console.error(`native smoke check failed: ${err instanceof Error ? err.message : err}`);
  exitFlushed(1);
}
