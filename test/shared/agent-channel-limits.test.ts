import { describe, it, expect } from "vitest";
import {
  AGENT_CHANNEL_DEFAULT_MAX_RESPONSE_BYTES,
  AGENT_CHANNEL_MAX_CHANNELS,
  AGENT_CHANNEL_MAX_STREAM_CHANNELS,
  AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS,
} from "../../src/shared/agent-channel.js";
import { maxResponseBodyBytesForPath } from "../../src/services/agent-channel-tunnel.js";
import { SCROLLBACK_MAX_BYTES } from "../../src/services/scrollback-buffer.js";
import { MAX_PAGE_BYTES, MAX_ENTRY_CHARS } from "../../src/services/session-transcript.js";
import { MAX_LOG_PAGE } from "../../src/services/git-log.js";

describe("outbound channel capacity constants (#2638)", () => {
  it("keeps at least half the slots for requests", () => {
    expect(AGENT_CHANNEL_MAX_STREAM_CHANNELS).toBeLessThanOrEqual(AGENT_CHANNEL_MAX_CHANNELS / 2);
    expect(AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS).toBeGreaterThanOrEqual(
      AGENT_CHANNEL_MAX_CHANNELS / 2,
    );
    expect(AGENT_CHANNEL_MAX_STREAM_CHANNELS + AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS).toBe(
      AGENT_CHANNEL_MAX_CHANNELS,
    );
  });
});

// The largest JSON the agent builds for the three paged reads, worst case, set
// against the default response limit. None needs a per-path override; if one
// grows past it, this fails and the override goes in maxResponseBodyBytesForPath
// with its own test.
describe("default tunnelled response limit covers the paged reads (#2638)", () => {
  const limit = AGENT_CHANNEL_DEFAULT_MAX_RESPONSE_BYTES;

  it("scrollback (base64 of the 1 MiB ring buffer)", () => {
    const b64 = Math.ceil((SCROLLBACK_MAX_BYTES * 4) / 3);
    expect(b64 * 2).toBeLessThan(limit); // x2 for the newest-slab overshoot
    expect(maxResponseBodyBytesForPath("/internal/sessions/1/scrollback")).toBe(limit);
  });

  it("transcript (a page is cut at 256 KiB; JSON escaping is at most 6x)", () => {
    const worstEntry = MAX_ENTRY_CHARS * 6;
    expect(MAX_PAGE_BYTES * 6 + worstEntry).toBeLessThan(limit);
    expect(maxResponseBodyBytesForPath("/internal/sessions/1/transcript")).toBe(limit);
  });

  it("git-log (one page of commits with a 4 KiB subject and ref list each)", () => {
    expect(MAX_LOG_PAGE * 8 * 1024).toBeLessThan(limit);
    expect(maxResponseBodyBytesForPath("/internal/git-log")).toBe(limit);
  });
});
