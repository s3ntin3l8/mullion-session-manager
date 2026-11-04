import { afterAll, beforeAll } from "vitest";

// Issue #2596 — an unread host protocol gates as the legacy baseline, which
// refuses every launch needing a newer option. Suites whose fake remote hosts
// never answer the handshake, so by default (a setup file, vitest.config.ts) a
// host with no recorded protocol reads as a current agent; a protocol a test
// records itself is left alone. A suite that tests the unread/legacy behaviour
// sets MULLION_TEST_REAL_PROTOCOL=1.
// The src imports are lazy so a suite's hoisted vi.mock factories apply first.
let restore: (() => void) | undefined;
afterAll(() => restore?.());
beforeAll(async () => {
  const { HostAgentTracker } = await import("../../src/services/host-agents.js");
  const { localProtocolInfo } = await import("../../src/shared/agent-protocol.js");
  const proto = HostAgentTracker.prototype as typeof HostAgentTracker.prototype & {
    __defaultProtocol?: true;
  };
  if (proto.__defaultProtocol) return;
  proto.__defaultProtocol = true;
  const realGet = proto.get;
  restore = () => {
    proto.get = realGet;
    delete proto.__defaultProtocol;
  };
  proto.get = function (this: InstanceType<typeof HostAgentTracker>, hostId: string) {
    const entry = realGet.call(this, hostId);
    if (entry?.protocol || process.env.MULLION_TEST_REAL_PROTOCOL === "1") return entry;
    return {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      checkedAt: 0,
      ...entry,
      protocol: { ...localProtocolInfo(), legacy: false },
    };
  };
});
