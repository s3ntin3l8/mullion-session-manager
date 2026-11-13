import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Issue #2568 / epic #2230 — the agent half of a persistent machine identity:
// `{hostId, machineCredential}` in a state file under the agent's data dir
// (SESSIONS_DIR, which an install pins to an absolute, release-independent
// path). The agent is otherwise stateless; this is the one
// thing it remembers across boots.
//
// The credential is a secret: the file is owner-only (0600; on Windows a
// per-user ACL), written atomically so a crash mid-write cannot leave a
// truncated identity, and the value is never logged or passed as a process
// argument (the Windows ACL call carries only the file path and user name).

export interface AgentIdentity {
  hostId: string;
  machineCredential: string;
}

// The primary issues a 32-byte hex credential and a UUID-ish host id. Both come
// off the network, so they are shape-checked before they reach the filesystem:
// anything else is refused rather than persisted.
const HOST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{16,512}$/;

const STATE_FILE_NAME = "agent-identity.json";
const execFileAsync = promisify(execFile);

export function identityStatePath(sessionsDir: string): string {
  return path.join(path.resolve(sessionsDir), STATE_FILE_NAME);
}

/** Null when there is no (usable) state file: the legacy / first-boot case. */
export function loadAgentIdentity(statePath: string): AgentIdentity | null {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentIdentity>;
    if (
      typeof parsed.hostId === "string" &&
      parsed.hostId &&
      typeof parsed.machineCredential === "string" &&
      parsed.machineCredential
    ) {
      return { hostId: parsed.hostId, machineCredential: parsed.machineCredential };
    }
  } catch {
    // fall through: a corrupt file is treated as absent (the error text could
    // quote file content, so it is deliberately not surfaced).
  }
  return null;
}

async function restrictToCurrentUserWindows(file: string): Promise<void> {
  // Drop inherited ACEs and grant only the current user. Arguments are the
  // path and account name — never the credential.
  const user = os.userInfo().username;
  await execFileAsync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
    windowsHide: true,
  });
}

/**
 * Atomically replace the state file: write a 0600 temp file in the same
 * directory, then rename over the target. Throws on failure; the caller
 * decides whether that is fatal (it is not — the session still works, the
 * agent just cannot keep its identity across a restart).
 */
export async function saveAgentIdentity(statePath: string, identity: AgentIdentity): Promise<void> {
  if (!HOST_ID_RE.test(identity.hostId) || !CREDENTIAL_RE.test(identity.machineCredential)) {
    throw new Error("refusing to persist a malformed machine identity");
  }
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${statePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ hostId: identity.hostId, machineCredential: identity.machineCredential }),
      { mode: 0o600 },
    );
    // writeFileSync's mode is subject to the umask and ignored if the temp
    // file pre-existed; chmod makes the restriction unconditional.
    if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
    else await restrictToCurrentUserWindows(tmp);
    fs.renameSync(tmp, statePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Whether `hostId` is this agent. An agent that has not enrolled yet (a
 * legacy or manual deployment) has no id of its own to compare against, so it
 * cannot tell and accepts the name the primary gave it.
 *
 * That fail-open case is deliberate (issue #2672): refusing would break every
 * legacy deployment's browser, and the agent has nothing to check the name
 * against. What still holds there is that the request already passed the
 * agent's bearer-token gate and the target only ever selects a context in this
 * machine's own pool, so a wrong `hostId` names a pool key, not another
 * machine. An enrolled agent enforces the check. */
export function agentServesHost(sessionsDir: string, hostId: string): boolean {
  const own = loadAgentIdentity(identityStatePath(sessionsDir))?.hostId;
  return own === undefined || own === hostId;
}
