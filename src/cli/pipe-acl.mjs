// Restrict a Windows named pipe to the user Mullion runs as (issue #2065) —
// the pipe-side counterpart of the `chmod 0600` every unix socket gets.
//
// Plain ESM next to ipc-path.mjs, for the same reason: its consumers are the
// compiled backend (the hook, control and ssh-agent sockets) AND the plain-ESM
// pty-host master (src/pty-host/master.mjs), which serves each session's pipe
// from its own detached process. The types live in pipe-acl.d.mts.
//
// Why this is needed: libuv creates a pipe with the DEFAULT security
// descriptor, which grants full control to SYSTEM, Administrators and the
// creator — and READ to Everyone and ANONYMOUS LOGON. Read is not write, and
// every Mullion server sends nothing before a client authenticates, but
// another local user (or an anonymous one) should not be able to open the
// pipe at all. Node can only WIDEN a pipe's access (`listen({ readableAll,
// writableAll })`), never narrow it, and it does not expose the pipe's
// handle.
//
// How: the pipe's security descriptor belongs to the PIPE, not to one
// instance — later instances libuv creates inherit it. So once the server is
// listening, a short-lived Windows PowerShell opens the pipe as a client with
// only ReadData + ReadPermissions + ChangePermissions (the creator owns it, so
// it may) and replaces its DACL with a PROTECTED one: the current user and
// SYSTEM, full control, nothing else. That client sends nothing and closes at
// once, so every server just sees a connection that never authenticated.
//
// Failure is not fatal: the caller logs it and keeps serving. Every Mullion
// pipe still has a second gate — the hook and control sockets' handshake
// token, the pty-host's session token — and the ssh-agent socket, which has
// none, is not served on Windows at all (materializesBridgeSocket).
import { execFile } from "node:child_process";
import { PIPE_PREFIX, isPipePath } from "./ipc-path.mjs";

/** Generous: a cold Windows PowerShell start alone can take a second or two. */
export const PIPE_ACL_TIMEOUT_MS = 15_000;

/** The env var the script reads the pipe's name from — never interpolated. */
export const PIPE_NAME_ENV = "MULLION_PIPE_NAME";

/**
 * The script Windows PowerShell runs. Fixed text: the pipe name reaches it
 * only through $env:MULLION_PIPE_NAME. Only .NET types — no cmdlet whose
 * module has to load (see pipeAclEnv for why that matters).
 */
export const PIPE_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:MULLION_PIPE_NAME, [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions, ChangePermissions', [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)",
  "$c.Connect(5000)",
  "try {",
  "  $s = New-Object System.IO.Pipes.PipeSecurity",
  "  $s.SetAccessRuleProtection($true, $false)",
  "  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "  $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')",
  "  foreach ($sid in @($me, $system)) {",
  "    $s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($sid, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))",
  "  }",
  "  $c.SetAccessControl($s)",
  "} finally { $c.Dispose() }",
].join("\n");

/**
 * The child's environment: ours, minus PSModulePath, plus the pipe name. A
 * PSModulePath inherited from PowerShell 7 points Windows PowerShell 5.1 at
 * modules it cannot load; without it, 5.1 uses its own defaults.
 */
export function pipeAclEnv(pipeName, env = process.env) {
  const out = { ...env, [PIPE_NAME_ENV]: pipeName };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "psmodulepath") delete out[key];
  }
  return out;
}

/**
 * Restrict `endpoint` to the current user and SYSTEM, if it is a named pipe
 * on Windows; anything else (a unix socket path, or any other platform) is a
 * no-op that resolves true. Resolves false — after `log`ging why — when the
 * DACL could not be set; never rejects. Call it once the server is listening.
 * `opts.env` is the environment the PowerShell child starts from (default
 * process.env) — the pty-host master passes one without its session token.
 */
export function restrictPipeToCurrentUser(endpoint, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" || !isPipePath(endpoint)) return Promise.resolve(true);
  const run = opts.execFile ?? execFile;
  const pipeName = endpoint.replace(/\//g, "\\").slice(PIPE_PREFIX.length);
  return new Promise((resolve) => {
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PIPE_ACL_SCRIPT],
      { timeout: PIPE_ACL_TIMEOUT_MS, windowsHide: true, env: pipeAclEnv(pipeName, opts.env) },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? "").trim() || err.message;
          opts.log?.(`could not restrict ${endpoint} to the current user: ${detail}`);
          resolve(false);
        } else {
          resolve(true);
        }
      },
    );
  });
}
