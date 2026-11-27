import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type * as ChildProcess from "node:child_process";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { buildTestAppOnPlatform, warmSqliteBinding } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { createPairedHost } from "../../src/services/host-registry.js";
import { insertDevice } from "../../src/services/device-store.js";
import { ChannelSocket } from "../../src/services/channel-socket.js";
import type { MuxChannel } from "../../src/services/ssh-agent-mux.js";
import {
  REMOTE_DEVICE_OPEN_TIMEOUT_MS,
  REMOTE_DEVICE_START_TIMEOUT_MS,
  REMOTE_DEVICE_VIDEO_TIMEOUT_MS,
  REMOTE_DEVICE_SECOND_CHANCE_MS,
} from "../../src/routes/device.js";

// Issue #3526: the panel's socket for an iOS Simulator on an agent host that
// is reached over its outbound channel, through the real entry point
// (`/ws/device/:deviceId`). The agent's side is stubbed at the client's device
// facet — what the channel answers — and the device stream is a real
// ChannelSocket, so no step of the relay is mocked. Every stall must end in an
// `error` message with a reason, never in a silent "Waiting for video…".
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const devicesFacet = {
  kinds: vi.fn(),
  spawn: vi.fn(),
  live: vi.fn(),
  openSocket: vi.fn(),
};
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return { ...actual, getRemoteHostClient: vi.fn(() => ({ devices: devicesFacet })) };
});

const tmpDb = path.join(os.tmpdir(), `device-remote-relay-test-${process.pid}.db`);

/** A mux channel that accepts every byte and never answers on its own. */
function fakeMuxChannel(): MuxChannel {
  return {
    id: 1,
    sendWindow: 1 << 20,
    closed: false,
    send: () => undefined,
    eof: () => undefined,
    close() {
      (this as { closed: boolean }).closed = true;
    },
    onData: () => undefined,
    onEof: () => undefined,
    onClose: () => undefined,
    onDrain: () => undefined,
    acknowledgeConsumed: () => undefined,
  } as unknown as MuxChannel;
}

describe("/ws/device/:deviceId for an iOS device on an outbound-channel host (#3526)", () => {
  let app: FastifyInstance;
  let deviceId: number;
  let hostId: string;
  let port: number;
  let originalPlatform: NodeJS.Platform;

  beforeEach(async () => {
    await warmSqliteBinding();
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DEVICE_ENABLED = "true";
    for (const fn of Object.values(devicesFacet)) fn.mockReset();
    devicesFacet.kinds.mockResolvedValue({ deviceKinds: [], platforms: ["android", "ios"] });
    devicesFacet.spawn.mockResolvedValue({ info: null, port: null });
    devicesFacet.live.mockResolvedValue({
      devices: [{ id: "1", kind: "emulator", status: "streaming", error: null }],
    });
    app = await buildTestAppOnPlatform("linux");
    // An outbound-only host: no advertised URL, reached over its channel.
    const host = createPairedHost(app, { hostname: "macbook", name: "macbook" });
    hostId = host.hostId;
    deviceId = insertDevice(app, {
      kind: "emulator",
      serial: null,
      avdName: null,
      projectId: null,
      name: "iPhone 17",
      hostId: host.hostId,
      platform: "ios",
      udid: "17CD1308-0F2B-4652-8986-3F9612A09F8E",
    }).id;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    port = address.port;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
  });

  /** Opens the panel's socket and collects the text messages it is sent. */
  async function openPanel() {
    // Only timers are faked, and before the upgrade: the relay arms its timers
    // as the socket arrives. The sockets keep real I/O.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/device/${deviceId}`);
    const messages: Array<{ type: string; message: string }> = [];
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") messages.push(JSON.parse(event.data));
    });
    const closed = new Promise<void>((resolve) =>
      ws.addEventListener("close", () => resolve(), { once: true }),
    );
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    return { ws, messages, closed };
  }

  it("fails the panel with a reason when getOrCreate never settles", async () => {
    devicesFacet.spawn.mockReturnValue(new Promise(() => undefined));
    const panel = await openPanel();
    await vi.waitFor(() => expect(devicesFacet.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_START_TIMEOUT_MS);
    await panel.closed;
    expect(panel.messages).toEqual([
      { type: "error", message: `Host ${hostId} did not start device ${deviceId} in time` },
    ]);
    expect(devicesFacet.openSocket).not.toHaveBeenCalled();
  });

  it("fails the panel with a reason when the device stream never opens", async () => {
    // Never bound to a channel: no open, no error, no refusal.
    devicesFacet.openSocket.mockReturnValue(new ChannelSocket({ expectHead: true }));
    const panel = await openPanel();
    await vi.waitFor(() => expect(devicesFacet.openSocket).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_OPEN_TIMEOUT_MS);
    await panel.closed;
    expect(panel.messages).toEqual([
      { type: "error", message: `Host ${hostId} did not answer in time` },
    ]);
  });

  it("fails the panel with a reason when the agent accepts the stream and sends no video", async () => {
    const stream = new ChannelSocket({ expectHead: true });
    stream.bind(fakeMuxChannel());
    devicesFacet.openSocket.mockReturnValue(stream);
    const panel = await openPanel();
    await vi.waitFor(() => expect(devicesFacet.openSocket).toHaveBeenCalled());
    // The agent's accept head: the stream is open, and then nothing comes.
    stream.ingest(Buffer.from('{"status":200}\n'));
    await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_VIDEO_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_SECOND_CHANCE_MS);
    await panel.closed;
    expect(panel.messages).toEqual([
      {
        type: "error",
        message: `Host ${hostId} reports device ${deviceId} streaming but sent this panel no video`,
      },
    ]);
    expect(devicesFacet.openSocket).toHaveBeenCalledWith(String(deviceId), {
      kind: "emulator",
      label: "iPhone 17",
      platform: "ios",
      udid: "17CD1308-0F2B-4652-8986-3F9612A09F8E",
    });
  });
});
