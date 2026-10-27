import { describe, it, expect, vi } from "vitest";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  PIPE_ACL_SCRIPT,
  PIPE_ACL_TIMEOUT_MS,
  PIPE_NAME_ENV,
  pipeAclEnv,
  restrictPipeToCurrentUser,
} from "../../src/cli/pipe-acl.mjs";
import { PIPE_PREFIX } from "../../src/cli/ipc-path.mjs";

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** A stand-in for child_process.execFile that records the call and answers with `result`. */
function fakeExecFile(result: { err?: Error; stderr?: string } = {}) {
  const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const fn = vi.fn(
    (file: string, args: string[], opts: Record<string, unknown>, cb: ExecCallback) => {
      calls.push({ file, args, opts });
      queueMicrotask(() => cb(result.err ?? null, "", result.stderr ?? ""));
    },
  );
  return { fn: fn as unknown as typeof execFile, calls };
}

// Low-entropy on purpose: a realistic hex hash here trips detect-secrets.
const PIPE_NAME = "mullion-0000000000000000-hooks";
const PIPE = `${PIPE_PREFIX}${PIPE_NAME}`;

describe("restrictPipeToCurrentUser", () => {
  it.each(["linux", "darwin"] as const)("is a no-op on %s", async (platform) => {
    const exec = fakeExecFile();
    await expect(restrictPipeToCurrentUser(PIPE, { platform, execFile: exec.fn })).resolves.toBe(
      true,
    );
    expect(exec.calls).toHaveLength(0);
  });

  it("is a no-op for a unix socket path, even on win32", async () => {
    const exec = fakeExecFile();
    await expect(
      restrictPipeToCurrentUser("C:\\data\\hooks.sock", { platform: "win32", execFile: exec.fn }),
    ).resolves.toBe(true);
    expect(exec.calls).toHaveLength(0);
  });

  it("runs the fixed script in Windows PowerShell, passing the pipe name only through the environment", async () => {
    const exec = fakeExecFile();
    await expect(
      restrictPipeToCurrentUser(PIPE, {
        platform: "win32",
        execFile: exec.fn,
        env: { PATH: "x", PSModulePath: "C:\\pwsh7\\Modules", MULLION_PTY_HOST_TOKEN: undefined },
      }),
    ).resolves.toBe(true);
    expect(exec.calls).toHaveLength(1);
    const [{ file, args, opts }] = exec.calls;
    expect(file).toBe("powershell.exe");
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", PIPE_ACL_SCRIPT]);
    expect(args.join(" ")).not.toContain(PIPE_NAME);
    expect(opts).toMatchObject({ timeout: PIPE_ACL_TIMEOUT_MS, windowsHide: true });
    const env = opts.env as NodeJS.ProcessEnv;
    expect(env[PIPE_NAME_ENV]).toBe(PIPE_NAME);
    expect(env.PATH).toBe("x");
    expect(env).not.toHaveProperty("PSModulePath");
  });

  it("accepts a forward-slash pipe spelling", async () => {
    const exec = fakeExecFile();
    await restrictPipeToCurrentUser("//./pipe/mullion-x-control", {
      platform: "win32",
      execFile: exec.fn,
    });
    expect((exec.calls[0].opts.env as NodeJS.ProcessEnv)[PIPE_NAME_ENV]).toBe("mullion-x-control");
  });

  it("logs and resolves false — never rejects — when PowerShell fails", async () => {
    const exec = fakeExecFile({ err: new Error("exit 1"), stderr: "  access denied \r\n" });
    const log = vi.fn();
    await expect(
      restrictPipeToCurrentUser(PIPE, { platform: "win32", execFile: exec.fn, log }),
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      `could not restrict ${PIPE} to the current user: access denied`,
    );
  });

  it("falls back to the error message when PowerShell printed nothing", async () => {
    const exec = fakeExecFile({ err: new Error("timed out") });
    const log = vi.fn();
    await restrictPipeToCurrentUser(PIPE, { platform: "win32", execFile: exec.fn, log });
    expect(log).toHaveBeenCalledWith(`could not restrict ${PIPE} to the current user: timed out`);
  });

  it("does not need a logger", async () => {
    const exec = fakeExecFile({ err: new Error("boom") });
    await expect(
      restrictPipeToCurrentUser(PIPE, { platform: "win32", execFile: exec.fn }),
    ).resolves.toBe(false);
  });
});

describe("pipeAclEnv", () => {
  it("drops PSModulePath in any letter case and adds the pipe name", () => {
    const env = pipeAclEnv("p", { A: "1", PSMODULEPATH: "x", psmodulepath: "y" });
    expect(env).toEqual({ A: "1", [PIPE_NAME_ENV]: "p" });
  });

  it("defaults to process.env", () => {
    expect(pipeAclEnv("p").PATH ?? pipeAclEnv("p").Path).toBe(process.env.PATH ?? process.env.Path);
  });
});

// The real thing: a pipe libuv created, narrowed, then read back through .NET
// (Windows only — runs in CI's test-windows job).
describe.runIf(process.platform === "win32")("restrictPipeToCurrentUser on a real pipe", () => {
  const run = promisify(execFile);

  /** The pipe's access rules, as "identity|rights|type" lines. */
  async function readAcl(pipeName: string): Promise<string[]> {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:MULLION_PIPE_NAME, [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions', [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)",
      "$c.Connect(5000)",
      "try { $c.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { '{0}|{1}|{2}' -f $_.IdentityReference, $_.PipeAccessRights, $_.AccessControlType } } finally { $c.Dispose() }",
    ].join("\n");
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, env: pipeAclEnv(pipeName) },
    );
    return stdout.trim().split(/\r?\n/).sort();
  }

  async function currentUserSid(): Promise<string> {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { windowsHide: true, env: pipeAclEnv("") },
    );
    return stdout.trim();
  }

  it("leaves only the current user and SYSTEM, for every later instance too", async () => {
    const name = `mullion-test-${randomBytes(6).toString("hex")}-acl`;
    const server = net.createServer((s) => s.on("error", () => {}));
    await new Promise<void>((resolve) => server.listen(`${PIPE_PREFIX}${name}`, resolve));
    try {
      // libuv's default: Everyone (S-1-1-0) and ANONYMOUS LOGON (S-1-5-7) can read.
      const before = await readAcl(name);
      expect(before.some((r) => r.startsWith("S-1-1-0|"))).toBe(true);

      const log = vi.fn();
      await expect(restrictPipeToCurrentUser(`${PIPE_PREFIX}${name}`, { log })).resolves.toBe(true);
      expect(log).not.toHaveBeenCalled();

      const me = await currentUserSid();
      const expected = [`${me}|FullControl|Allow`, "S-1-5-18|FullControl|Allow"].sort();
      expect(await readAcl(name)).toEqual(expected);

      // More clients force libuv to create more instances; they share the DACL.
      const clients = await Promise.all(
        [1, 2, 3, 4, 5].map(
          () =>
            new Promise<net.Socket>((resolve, reject) => {
              const c = net.connect(`${PIPE_PREFIX}${name}`, () => resolve(c));
              c.on("error", reject);
            }),
        ),
      );
      expect(await readAcl(name)).toEqual(expected);
      for (const c of clients) c.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
