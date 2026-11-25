import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createMuxConnection } from "../../src/services/ssh-agent-mux.js";
import {
  AGENT_CHANNEL_MAX_CHANNELS,
  channelFetch,
} from "../../src/services/agent-channel-tunnel.js";
import type { ConnectedAgentChannel } from "../../src/plugins/agent-channel.js";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0).reverse()) c();
});

describe("an exchange on a channel the peer closed in the same read (#3515)", () => {
  it("fails within its timeout instead of hanging when the peer acks the open and closes it at once", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    const serverSide = new Promise<WebSocket>((r) => wss.once("connection", r));
    const agentSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    const primarySocket = await serverSide;
    await new Promise((r) => agentSocket.once("open", r));
    const primaryMux = createMuxConnection(primarySocket as never, {
      channelIdParity: "even",
      maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
    });
    const agentMux = createMuxConnection(agentSocket as never, {
      channelIdParity: "odd",
      maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
    });
    agentMux.onChannel((ch) => ch.close());
    closers.push(() => {
      primaryMux.close();
      agentMux.close();
      primarySocket.terminate();
      agentSocket.terminate();
      wss.close();
    });
    const entry = { mux: primaryMux, terminal: null } as unknown as ConnectedAgentChannel;
    const outcome = await Promise.race([
      channelFetch(entry, { method: "GET", path: "/internal/protocol", timeoutMs: 200 }).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((r) => setTimeout(() => r("hung"), 1500)),
    ]);
    expect(outcome).toBe("rejected");
  });
});
