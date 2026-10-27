// Issue #2160 — the Windows launcher is plain Node with no platform-specific
// call in it, so everything here runs on every platform's CI, not just
// Windows': the .env parser, the restart backoff, the rotating log, the
// supervise loop (against a fake server), and main() against a real child.
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEALTHY_UPTIME_MS,
  describeExit,
  LOG_MAX_BYTES,
  RESTART_BASE_MS,
  RESTART_MAX_MS,
  STDIO_DRAIN_MS,
  RotatingLog,
  main,
  nextRestartDelay,
  parseEnvFile,
  serverEnv,
  supervise,
} from "../../scripts/windows-launcher.mjs";

const LAUNCHER_PATH = fileURLToPath(new URL("../../scripts/windows-launcher.mjs", import.meta.url));

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "windows-launcher-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseEnvFile", () => {
  it("reads KEY=VALUE literally, the way EnvironmentFile= does", () => {
    const vars = parseEnvFile(
      [
        "# a comment",
        "",
        "PLAIN=value",
        "SPACES=Studio Mac",
        "DOLLAR=$HOME and `backticks` and $(cmd)",
        "EMPTY=",
        "EQUALS=a=b=c",
        "no equals sign here",
        "9BAD=starts with a digit",
        "BAD-KEY=has a dash",
      ].join("\n"),
    );
    expect(vars).toEqual({
      PLAIN: "value",
      SPACES: "Studio Mac",
      DOLLAR: "$HOME and `backticks` and $(cmd)",
      EMPTY: "",
      EQUALS: "a=b=c",
    });
  });

  it("strips one layer of matching quotes and leaves the contents alone", () => {
    const vars = parseEnvFile(
      ['A="double quoted"', "B='single quoted'", "C=\"mismatched'", 'D=""quoted""', 'E="'].join(
        "\n",
      ),
    );
    expect(vars.A).toBe("double quoted");
    expect(vars.B).toBe("single quoted");
    expect(vars.C).toBe("\"mismatched'");
    expect(vars.D).toBe('"quoted"');
    expect(vars.E).toBe('"');
  });

  it("survives CRLF line endings — a .env edited on Windows", () => {
    expect(parseEnvFile('A=1\r\nB="two"\r\n# c\r\nC=three\r\n')).toEqual({
      A: "1",
      B: "two",
      C: "three",
    });
  });

  it("lets a later line win, as the shell launcher's repeated export does", () => {
    expect(parseEnvFile("A=1\nA=2")).toEqual({ A: "2" });
  });
});

describe("describeExit", () => {
  it("words a plain exit code, a signal, and a Windows force-kill", () => {
    expect(describeExit(1, null)).toBe("code 1");
    expect(describeExit(null, "SIGKILL")).toBe("signal SIGKILL");
    // TerminateProcess(-1) arrives as an unsigned 32-bit value.
    expect(describeExit(4294967295, null)).toBe("code -1");
    expect(describeExit(0x7fffffff, null)).toBe("code 2147483647");
  });
});

describe("nextRestartDelay", () => {
  it("starts at the base, doubles while the server keeps failing fast, and caps", () => {
    let delay: number | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      delay = nextRestartDelay(delay, 1_000);
      seen.push(delay as number);
    }
    expect(seen.slice(0, 4)).toEqual([RESTART_BASE_MS, 4_000, 8_000, 16_000]);
    expect(seen.at(-1)).toBe(RESTART_MAX_MS);
  });

  it("resets to the base once the server stayed up long enough to be healthy", () => {
    expect(nextRestartDelay(RESTART_MAX_MS, HEALTHY_UPTIME_MS)).toBe(RESTART_BASE_MS);
    expect(nextRestartDelay(RESTART_MAX_MS, HEALTHY_UPTIME_MS - 1)).toBe(RESTART_MAX_MS);
  });
});

describe("RotatingLog", () => {
  it("appends, and carries on from a file that already has content", () => {
    const file = path.join(tmpDir(), "logs", "mullion.log");
    const first = new RotatingLog(file, 1000);
    first.write("one\n");
    first.close();
    const second = new RotatingLog(file, 1000);
    second.write("two\n");
    second.close();
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  it("rotates to <file>.1 when a write would pass the limit, keeping one generation", () => {
    const file = path.join(tmpDir(), "mullion.log");
    const log = new RotatingLog(file, 10);
    log.write("aaaaaaaa\n"); // 9 bytes
    log.write("bbbbbbbb\n"); // would be 18 > 10 → rotate first
    log.write("cccccccc\n"); // rotates again, replacing .1
    log.close();
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("bbbbbbbb\n");
    expect(fs.readFileSync(file, "utf8")).toBe("cccccccc\n");
  });

  it("never rotates an empty file for one oversized write", () => {
    const file = path.join(tmpDir(), "mullion.log");
    const log = new RotatingLog(file, 4);
    log.write("a line longer than the limit\n");
    log.close();
    expect(fs.existsSync(`${file}.1`)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("a line longer than the limit\n");
  });

  it("never throws: a log that cannot be written loses the line, not the supervisor", () => {
    const file = path.join(tmpDir(), "mullion.log");
    const log = new RotatingLog(file, 1000);
    log.write("before\n");
    log.close();
    // fd closed under it: the old code threw EBADF here, inside a stream handler.
    expect(() => log.write("after close\n")).not.toThrow();
    // ...and a later write recovers by reopening.
    log.write("recovered\n");
    log.close();
    expect(fs.readFileSync(file, "utf8")).toContain("recovered");
  });

  it("keeps appending, and does not rotate on every write, when the old generation cannot be replaced", () => {
    const file = path.join(tmpDir(), "mullion.log");
    // A non-empty directory at <file>.1 makes the rename fail.
    fs.mkdirSync(`${file}.1`);
    fs.writeFileSync(path.join(`${file}.1`, "occupied"), "x");
    const log = new RotatingLog(file, 25);
    const lines = ["aaaaaaaa\n", "bbbbbbbb\n", "cccccccc\n", "dddddddd\n", "eeeeeeee\n"];
    for (const line of lines) log.write(line);
    log.close();
    // Nothing lost, nothing thrown, and the occupant is untouched.
    expect(fs.readFileSync(file, "utf8")).toBe(lines.join(""));
    expect(fs.readFileSync(path.join(`${file}.1`, "occupied"), "utf8")).toBe("x");
  });

  it("defaults to a 10 MiB limit", () => {
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("serverEnv", () => {
  it("overlays the .env on the launcher's environment, and defaults the home and the task", () => {
    const env = serverEnv({
      home: "C:/Mullion",
      taskName: "Mullion-agent",
      baseEnv: { PATH: "p", PORT: "1" },
      envFileText: "PORT=2\nMULLION_ROLE=agent\n",
    });
    expect(env).toMatchObject({
      PATH: "p",
      PORT: "2",
      MULLION_ROLE: "agent",
      MULLION_HOME: "C:/Mullion",
      MULLION_SERVICE_UNIT: "Mullion-agent",
    });
  });

  it("lets the .env decide MULLION_HOME and MULLION_SERVICE_UNIT", () => {
    const env = serverEnv({
      home: "C:/Mullion",
      taskName: "Mullion-agent",
      baseEnv: {},
      envFileText: "MULLION_HOME=D:/elsewhere\nMULLION_SERVICE_UNIT=custom\n",
    });
    expect(env.MULLION_HOME).toBe("D:/elsewhere");
    expect(env.MULLION_SERVICE_UNIT).toBe("custom");
  });

  it("on Windows a .env PATH replaces the inherited Path instead of sitting beside it", () => {
    const env = serverEnv({
      home: "h",
      taskName: "",
      baseEnv: { Path: "C:\\inherited", Other: "1" },
      envFileText: "PATH=C:\\from-env\n",
      caseInsensitive: true,
    });
    expect(Object.keys(env).filter((k) => k.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toBe("C:\\from-env");
    expect(env.Other).toBe("1");
  });

  it("elsewhere keeps keys that differ only by case — the environment is case-sensitive there", () => {
    const env = serverEnv({
      home: "h",
      taskName: "",
      baseEnv: { Path: "a" },
      envFileText: "PATH=b\n",
      caseInsensitive: false,
    });
    expect(env).toMatchObject({ Path: "a", PATH: "b" });
  });

  describe("nodeDir", () => {
    const sep = path.delimiter;

    it("goes first on PATH when it is not already there, keeping the key's spelling", () => {
      const env = serverEnv({
        home: "h",
        taskName: "",
        baseEnv: { Path: `C:/a${sep}C:/b` },
        envFileText: "",
        caseInsensitive: true,
        nodeDir: "C:/runtime/node",
      });
      expect(env.Path).toBe(["C:/runtime/node", "C:/a", "C:/b"].join(sep));
      expect(env).not.toHaveProperty("PATH");
    });

    it("leaves PATH alone when the directory is already on it (case-insensitively on Windows)", () => {
      const baseEnv = { Path: `C:/a${sep}C:/Runtime/Node` };
      const env = serverEnv({
        home: "h",
        taskName: "",
        baseEnv,
        envFileText: "",
        caseInsensitive: true,
        nodeDir: "c:/runtime/node",
      });
      expect(env.Path).toBe(baseEnv.Path);
    });

    it("creates PATH when there is none, and honours a PATH from the .env", () => {
      expect(
        serverEnv({ home: "h", taskName: "", baseEnv: {}, envFileText: "", nodeDir: "/n" }).PATH,
      ).toBe("/n");
      expect(
        serverEnv({
          home: "h",
          taskName: "",
          baseEnv: { PATH: "/inherited" },
          envFileText: "PATH=/from-env\n",
          nodeDir: "/n",
        }).PATH,
      ).toBe(`/n${sep}/from-env`);
    });
  });

  it("sets no service unit when it was given no task name", () => {
    expect(serverEnv({ home: "h", taskName: "", baseEnv: {}, envFileText: "" })).not.toHaveProperty(
      "MULLION_SERVICE_UNIT",
    );
  });
});

describe("supervise", () => {
  /** A fake clock + sleeper: sleeping advances time instead of waiting. */
  function fakeTime() {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      advance: (ms: number) => (t += ms),
      sleep: (ms: number) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
      slept,
    };
  }

  it("restarts a failing server with a growing delay, and stops at a clean exit", async () => {
    const time = fakeTime();
    const exits = [1, 1, 1, 0];
    const logs: string[] = [];
    const { done } = supervise({
      runServer: async () => {
        time.advance(500);
        return { code: exits.shift() as number, signal: null };
      },
      sleep: time.sleep,
      now: time.now,
      log: (line: string) => logs.push(line),
    });
    expect(await done).toBe(0);
    expect(time.slept).toEqual([2_000, 4_000, 8_000]);
    expect(logs.at(-1)).toMatch(/exited cleanly; not restarting/);
    expect(logs[0]).toMatch(/exited \(code 1\); restarting in 2000 ms/);
  });

  it("resets the delay after a server that ran long enough to be healthy", async () => {
    const time = fakeTime();
    const runs = [
      { uptime: 100, code: 1 },
      { uptime: 100, code: 1 },
      { uptime: HEALTHY_UPTIME_MS, code: 1 },
      { uptime: 100, code: 0 },
    ];
    const { done } = supervise({
      runServer: async () => {
        const run = runs.shift()!;
        time.advance(run.uptime);
        return { code: run.code, signal: null };
      },
      sleep: time.sleep,
      now: time.now,
    });
    await done;
    expect(time.slept).toEqual([2_000, 4_000, 2_000]);
  });

  it("reports a signal death in the log", async () => {
    const time = fakeTime();
    const logs: string[] = [];
    const exits: Array<[number | null, string | null]> = [
      [null, "SIGKILL"],
      [0, null],
    ];
    await supervise({
      runServer: async () => {
        const [code, signal] = exits.shift()!;
        return { code, signal };
      },
      sleep: time.sleep,
      now: time.now,
      log: (line: string) => logs.push(line),
    }).done;
    expect(logs[0]).toMatch(/signal SIGKILL/);
  });

  it("stop() ends a pending restart delay and returns without starting another server", async () => {
    let starts = 0;
    const { done, stop } = supervise({
      runServer: async () => {
        starts++;
        return { code: 1, signal: null };
      },
      // never resolves on its own: only stop() can end the wait
      sleep: () => new Promise(() => {}),
    });
    await new Promise((resolve) => setImmediate(resolve));
    stop();
    expect(await done).toBe(0);
    expect(starts).toBe(1);
  });

  it("stop() while the server runs returns that server's exit code and does not restart it", async () => {
    let starts = 0;
    let finish: (v: { code: number; signal: null }) => void = () => {};
    const { done, stop } = supervise({
      runServer: () => {
        starts++;
        return new Promise((resolve) => (finish = resolve));
      },
    });
    stop();
    finish({ code: 3, signal: null });
    expect(await done).toBe(3);
    expect(starts).toBe(1);
  });
});

describe("main", () => {
  /** A fake install: <home>/current/dist/server.js running `body`. */
  function fakeInstall(body: string, envFile?: string): string {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, "current", "dist"), { recursive: true });
    fs.writeFileSync(path.join(home, "current", "dist", "server.js"), body);
    if (envFile !== undefined) fs.writeFileSync(path.join(home, ".env"), envFile);
    return home;
  }
  const readLog = (home: string) => fs.readFileSync(path.join(home, "logs", "mullion.log"), "utf8");

  it("starts the server from current/ with the .env applied, logs its output, and exits with its code", async () => {
    const home = fakeInstall(
      [
        'console.log("cwd-ok=" + (process.cwd().endsWith("current")));',
        'console.log("role=" + process.env.MULLION_ROLE);',
        'console.log("home=" + process.env.MULLION_HOME);',
        'console.log("unit=" + process.env.MULLION_SERVICE_UNIT);',
        'console.error("to-stderr");',
      ].join("\n"),
      "MULLION_ROLE=agent\r\n",
    );
    expect(await main(["node", "launcher", home, "Mullion-agent"], {})).toBe(0);
    const log = readLog(home);
    expect(log).toContain("cwd-ok=true");
    expect(log).toContain("role=agent");
    expect(log).toContain(`home=${home}`);
    expect(log).toContain("unit=Mullion-agent");
    expect(log).toContain("to-stderr");
    expect(log).toMatch(/\[launcher\] starting the server/);
    expect(log).toMatch(/\[launcher\] exiting with code 0/);
  });

  it("fails with a pointer when the install is incomplete", async () => {
    const home = tmpDir();
    expect(await main(["node", "launcher", home], {})).toBe(1);
    expect(readLog(home)).toMatch(/server\.js does not exist — is the install complete\?/);
  });

  it("restarts a server that failed, and picks up a .env edited in between", async () => {
    // First run: exits 1 after leaving a marker. The .env is edited by the
    // server itself (as an operator would between restarts); the second run
    // sees the new value and exits cleanly.
    const home = fakeInstall(
      [
        'const fs = require("node:fs");',
        'const marker = "../restarted";',
        "if (!fs.existsSync(marker)) {",
        '  fs.writeFileSync(marker, "1");',
        '  fs.appendFileSync("../.env", "SECOND=yes\\n");',
        "  process.exit(1);",
        "}",
        'console.log("second=" + process.env.SECOND);',
      ].join("\n"),
      "FIRST=1\n",
    );
    expect(await main(["node", "launcher", home], {})).toBe(0);
    expect(readLog(home)).toContain("second=yes");
  }, 15_000);

  it("stops the server and exits when it is told to — and does not restart it", async () => {
    const home = fakeInstall('console.log("up"); setInterval(() => {}, 1000);');
    const signals = new EventEmitter();
    const done = main(["node", "launcher", home], {}, signals);
    const deadline = Date.now() + 10_000;
    while (
      !fs.existsSync(path.join(home, "logs", "mullion.log")) ||
      !readLog(home).includes("up")
    ) {
      if (Date.now() > deadline) throw new Error("the server never came up");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    signals.emit("SIGTERM");
    expect(typeof (await done)).toBe("number");
    const log = readLog(home);
    expect(log).toContain("received SIGTERM; stopping the server");
    expect(log).not.toContain("restarting in");
    // The handlers are gone: nothing is left listening on the injected source.
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  }, 20_000);

  it("gets the server's last words into the log even when it exits straight after writing them", async () => {
    // 'exit' can come before the output pipes drain; the last lines of a crash
    // are the ones that matter.
    const home = fakeInstall(
      'for (let i = 0; i < 300; i++) console.error("line-" + i + " " + "x".repeat(200)); console.error("final-words");',
    );
    expect(await main(["node", "launcher", home], {})).toBe(0);
    const log = readLog(home);
    expect(log).toContain("line-0 ");
    expect(log).toContain("line-299 ");
    expect(log).toContain("final-words");
  });

  it("does not wait for a grandchild that kept the output pipes open after the server exited", async () => {
    // A long-lived grandchild that inherited the pipes holds 'close' off; the
    // supervisor must still see the server's exit and not hang.
    const home = fakeInstall(
      [
        'const { spawn } = require("node:child_process");',
        'spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { stdio: "inherit" }).unref();',
        'console.log("server done");',
      ].join("\n"),
    );
    const started = Date.now();
    expect(await main(["node", "launcher", home], {})).toBe(0);
    expect(Date.now() - started).toBeLessThan(STDIO_DRAIN_MS + 2_500);
    expect(readLog(home)).toContain("server done");
  }, 20_000);

  it("needs an install root", async () => {
    expect(await main(["node", "launcher"], {})).toBe(2);
  });

  it("still runs when node is started through a link to its directory — the task starts it via `current`", async () => {
    // Node resolves the main module through links, so import.meta.url is the
    // real path while process.argv[1] is the link's: comparing the two
    // directly made the launcher silently do nothing.
    const root = tmpDir();
    const scriptsLink = path.join(root, "scripts-link");
    fs.symlinkSync(path.dirname(LAUNCHER_PATH), scriptsLink, "junction");
    const result = spawnSync(process.execPath, [path.join(scriptsLink, "windows-launcher.mjs")], {
      encoding: "utf8",
    });
    expect(result.stderr).toContain("usage: node windows-launcher.mjs <mullion-home>");
    expect(result.status).toBe(2);
  });
});
