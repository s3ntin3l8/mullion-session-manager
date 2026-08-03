import { describe, it, expect, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
  probeSocket,
  isSocketLive,
  reclaimSocketPath,
  SocketAlreadyListeningError,
  PROBE_TIMEOUT_MS,
} from "../../src/services/unix-socket.js";

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `unix-socket-test-${process.pid}-${name}.sock`);
}

/** Simulates the exact scenario this module exists for: a process that
 * exited without cleanly unlinking its socket file (crash, kill -9). A
 * graceful `server.close()` in the same process auto-removes the file on
 * this platform, so that's not a faithful simulation — this spawns a real
 * child process to bind the socket, then SIGKILLs it: the file outlives the
 * listener (only a clean shutdown unlinks it), and connecting afterward
 * gets ECONNREFUSED, exactly like a stale socket left by a crash. */
async function createStaleSocketFile(socketPath: string): Promise<void> {
  // The socket path travels as a plain argv value (process.argv[1], after
  // the `--` separator), not interpolated into the -e script text itself —
  // the script string is a fixed literal with no embedded data, so nothing
  // here constructs code from a runtime value.
  const child = spawn("node", [
    "-e",
    'require("net").createServer(()=>{}).listen(process.argv[1], () => console.log("ready")); setInterval(()=>{}, 1000);',
    "--",
    socketPath,
  ]);
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("probeSocket / isSocketLive", () => {
  it("resolves dead/false for a path with nothing there", async () => {
    const p = tmpSocketPath("absent");
    expect(await probeSocket(p)).toBe("dead");
    expect(await isSocketLive(p)).toBe(false);
  });

  it("resolves live/true for a path with an actual listener", async () => {
    const p = tmpSocketPath("live");
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(p, resolve));
    try {
      expect(await probeSocket(p)).toBe("live");
      expect(await isSocketLive(p)).toBe(true);
    } finally {
      server.close();
      fs.rmSync(p, { force: true });
    }
  });

  it("resolves dead/false for a stale socket file left behind by a killed process", async () => {
    const p = tmpSocketPath("stale");
    await createStaleSocketFile(p);
    expect(fs.existsSync(p)).toBe(true);
    expect(await probeSocket(p)).toBe("dead");
    expect(await isSocketLive(p)).toBe(false);
    fs.rmSync(p, { force: true });
  });

  it("resolves unknown for a path the caller has no permission to connect to", async () => {
    const p = tmpSocketPath("perms");
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(p, resolve));
    fs.chmodSync(p, 0o000);
    try {
      expect(await probeSocket(p)).toBe("unknown");
    } finally {
      fs.chmodSync(p, 0o600);
      server.close();
      fs.rmSync(p, { force: true });
    }
  });

  it("resolves unknown when the probe doesn't settle within PROBE_TIMEOUT_MS", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A private, unpredictable directory (not a fixed path directly under
    // os.tmpdir(), which a symlink planted by another local user could
    // intercept) — only existsSync() needs to see something here, so a
    // plain marker file inside it is enough.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unix-socket-test-hangs-"));
    const p = path.join(dir, "hangs.sock");
    fs.writeFileSync(p, "");
    const fakeSocket = new EventEmitter() as EventEmitter & { destroy: () => void };
    fakeSocket.destroy = vi.fn();
    const spy = vi
      .spyOn(net, "createConnection")
      .mockReturnValue(fakeSocket as unknown as net.Socket);
    try {
      const resultPromise = probeSocket(p);
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      expect(await resultPromise).toBe("unknown");
      expect(fakeSocket.destroy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reclaimSocketPath", () => {
  it("removes a stale file and resolves without error", async () => {
    const p = tmpSocketPath("reclaim-stale");
    await createStaleSocketFile(p);
    expect(fs.existsSync(p)).toBe(true);

    await expect(reclaimSocketPath(p)).resolves.toBeUndefined();
    expect(fs.existsSync(p)).toBe(false);
  });

  it("resolves without error when the path is absent (nothing to remove)", async () => {
    const p = tmpSocketPath("reclaim-absent");
    await expect(reclaimSocketPath(p)).resolves.toBeUndefined();
  });

  // The actual regression this module fixes: reclaimSocketPath used to be an
  // unconditional unlinkSync, which silently deleted a *live* process's
  // control/hook socket out from under it. This is the test that would have
  // caught it.
  it("throws SocketAlreadyListeningError and leaves a live listener untouched", async () => {
    const p = tmpSocketPath("reclaim-live");
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(p, resolve));
    try {
      await expect(reclaimSocketPath(p)).rejects.toThrow(SocketAlreadyListeningError);
      expect(fs.existsSync(p)).toBe(true);
      expect(await isSocketLive(p)).toBe(true);
    } finally {
      server.close();
      fs.rmSync(p, { force: true });
    }
  });

  it("throws SocketAlreadyListeningError rather than guessing when the probe is inconclusive", async () => {
    const p = tmpSocketPath("reclaim-unknown");
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(p, resolve));
    fs.chmodSync(p, 0o000);
    try {
      await expect(reclaimSocketPath(p)).rejects.toThrow(SocketAlreadyListeningError);
      expect(fs.existsSync(p)).toBe(true);
    } finally {
      fs.chmodSync(p, 0o600);
      server.close();
      fs.rmSync(p, { force: true });
    }
  });
});
