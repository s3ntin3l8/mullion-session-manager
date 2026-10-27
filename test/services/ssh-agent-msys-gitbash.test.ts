import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { materializeSshAgentSocket } from "../../src/services/ssh-agent-socket.js";
import { parseMsysSocketFile, writeMsysSocketFile } from "../../src/services/msys-socket.js";
import { SocketAlreadyListeningError } from "../../src/services/unix-socket.js";
import { sessionShellOrNull } from "../../src/services/session-shell.js";
import type { MuxChannel } from "../../src/services/ssh-agent-mux.js";

// Issue #2131 — the whole Windows path, for real: the socket file created by
// Windows PowerShell with its protected DACL, and Git Bash's own `ssh-add -l`
// (an MSYS build, started the way a session starts its shell) talking to the
// bridge through it. Runs in CI's test-windows job.

const run = promisify(execFile);

/** Answers every agent request as "no identities" (SSH2_AGENT_IDENTITIES_ANSWER, 0 keys). */
function identitiesChannel(): MuxChannel {
  let onData: ((chunk: Buffer) => void) | null = null;
  let onClose: (() => void) | null = null;
  let closed = false;
  return {
    id: 1,
    sendWindow: 256 * 1024,
    get closed() {
      return closed;
    },
    send: () => onData?.(Buffer.from("000000050c00000000", "hex")),
    eof: () => undefined,
    close: () => {
      if (closed) return;
      closed = true;
      onClose?.();
    },
    onData: (l) => {
      onData = l;
    },
    onEof: () => undefined,
    onClose: (l) => {
      onClose = l;
    },
    onDrain: () => undefined,
    acknowledgeConsumed: () => undefined,
  };
}

const bash = process.platform === "win32" ? sessionShellOrNull() : null;

describe.runIf(bash)("ssh-agent bridge over an MSYS socket, with Git Bash's ssh-add", () => {
  it("lets Git Bash's ssh-add reach the bridge, from a file only this user and SYSTEM can read", async () => {
    // A short base: MSYS socket paths are capped at 107 bytes.
    const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "msys-"));
    const socketPath = path.join(dir, "ssh-agent.sock");
    const handle = await materializeSshAgentSocket({
      socketPath,
      openChannel: () => Promise.resolve(identitiesChannel()),
    });
    try {
      const attrib = await run("attrib", [socketPath]);
      expect(attrib.stdout).toMatch(/^\s*A?\s*S\s/);

      const acl = await run("icacls", [socketPath]);
      expect(acl.stdout).toMatch(/NT AUTHORITY\\SYSTEM:\(F\)/);
      expect(acl.stdout).not.toMatch(/Users|Everyone|Administrators|\(I\)/);

      // The real script never overwrites a file that is already there.
      await expect(writeMsysSocketFile(socketPath, "!<socket >1 s x")).rejects.toBeInstanceOf(
        SocketAlreadyListeningError,
      );

      const result = await run(bash!, ["-lc", "ssh-add -l; echo rc=$?"], {
        env: { ...process.env, SSH_AUTH_SOCK: socketPath },
        timeout: 60_000,
      }).catch((err: { stdout?: string; stderr?: string }) => err);
      expect(result.stdout).toContain("The agent has no identities.");
      expect(result.stdout).toContain("rc=1");

      // And a connection that does not know the secret gets nothing.
      const { port } = parseMsysSocketFile(readFileSync(socketPath, "latin1"))!;
      const stranger = net.createConnection({ host: "127.0.0.1", port });
      const echoed: Buffer[] = [];
      stranger.on("data", (d: Buffer) => echoed.push(d));
      stranger.on("error", () => undefined);
      stranger.write(Buffer.alloc(16));
      await new Promise((resolve) => stranger.once("close", resolve));
      expect(echoed).toEqual([]);
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
