import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { buildTestApp } from "../helpers/app.js";

// The agent-role half of the ssh-agent bridge (src/plugins/ssh-agent.ts): each
// accepted SSH connection opens a channel on the primary-facing mux, and that
// channel is a stream, so it honours the stream cap (#2673). The primary-role
// half is covered in ssh-agent-primary.test.ts.
let projectsRoot: string;
let prevSshAuthSock: string | undefined;

beforeEach(() => {
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-agent-agent-role-"));
  process.env.MULLION_ROLE = "agent";
  process.env.MULLION_AGENT_TOKEN = "test-agent-token";
  process.env.PROJECTS_ROOTS = projectsRoot;
  prevSshAuthSock = process.env.MULLION_SSH_AUTH_SOCK;
  delete process.env.MULLION_SSH_AUTH_SOCK;
});

afterEach(() => {
  delete process.env.MULLION_ROLE;
  delete process.env.MULLION_AGENT_TOKEN;
  delete process.env.PROJECTS_ROOTS;
  if (prevSshAuthSock === undefined) delete process.env.MULLION_SSH_AUTH_SOCK;
  else process.env.MULLION_SSH_AUTH_SOCK = prevSshAuthSock;
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

describe("sshAgentPlugin — agent role", () => {
  it("opens every per-connection channel as a stream at the openChannel seam", async () => {
    const app = await buildTestApp();
    expect(app.config.MULLION_ROLE).toBe("agent");
    const channel = {
      id: 1,
      sendWindow: 256 * 1024,
      closed: false,
      send() {},
      eof() {},
      close() {},
      onData() {},
      onEof() {},
      onClose() {},
      onDrain() {},
      acknowledgeConsumed() {},
    };
    const openChannel = vi.fn((_opts?: { stream?: boolean }) => Promise.resolve(channel));
    app.sshAgentBridgeConnection.current = { openChannel } as never;

    const client = net.createConnection(
      path.join(path.dirname(app.pty.hookSocketPath), "ssh-agent.sock"),
    );
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });
    client.write(Buffer.from("x"));
    await vi.waitFor(() => expect(openChannel).toHaveBeenCalled());
    expect(openChannel).toHaveBeenCalledWith({ stream: true });

    client.destroy();
    app.sshAgentBridgeConnection.current = null;
  });
});
