// Issue #1059 — cross-validation for the SSH-agent-bridge's two pairs of
// hand-maintained twins, the drift risk each twin's own header comment warns
// about:
//
//   - MAX_FRAME_BYTES in src/cli/ssh-agent-filter.mjs (laptop) vs
//     src/services/ssh-agent-filter.ts (server). Same value, hand-maintained
//     independently. Test/fixtures/ssh-agent-filter-vectors.json is the
//     existing shared source of truth (round 4 PR1) — both twins' tests
//     already validate their OWN constant against the fixture; this file's
//     job is the missing third leg: that the two twins agree with EACH
//     OTHER, not just with the fixture.
//
//   - CHANNEL_WINDOW_BYTES in src/cli/ssh-agent-bridge-mux.mjs (laptop) vs
//     src/services/ssh-agent-mux.ts (server). Same drift risk, same shared
//     fixture (under muxTransport.channelWindowBytes, added by this PR's
//     generator change). The .mjs twin is hand-maintained — a change to
//     either twin that doesn't also update the other now fails this test.
//
// A literal-comment-only cross check (import both, toBe equal) is all
// either side needs: a real divergence (one twin's ceiling twice the other's)
// would be silently absorbed by the protocol's own per-peer clamping
// (each side clamps to what IT was granted), so the failure mode would be
// a noticeable performance/correctness cliff with no test signal — exactly
// what this test exists to catch. The fixture is the source of truth; the
// twins agree by construction when both agree with the fixture, but
// asserting all three equal in one place lets a future fixture edit that
// happens to land BOTH twins wrong by the same amount (unlikely, but
// possible after a copy-paste refactor) fail here rather than only on
// whichever downstream code first notices the actual mismatch.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_FRAME_BYTES as LAPTOP_MAX_FRAME_BYTES } from "../../src/cli/ssh-agent-filter.mjs";
import { MAX_FRAME_BYTES as SERVER_MAX_FRAME_BYTES } from "../../src/services/ssh-agent-filter.js";
import { CHANNEL_WINDOW_BYTES as LAPTOP_CHANNEL_WINDOW_BYTES } from "../../src/cli/ssh-agent-bridge-mux.mjs";
import { CHANNEL_WINDOW_BYTES as SERVER_CHANNEL_WINDOW_BYTES } from "../../src/services/ssh-agent-mux.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/ssh-agent-filter-vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  wireFormat: { maxFrameBytes: number };
  muxTransport: { channelWindowBytes: number };
};

describe("ssh-agent-bridge twin constants (issue #1059)", () => {
  describe("MAX_FRAME_BYTES — the sign-only filter's frame ceiling", () => {
    it("laptop .mjs twin matches server .ts twin", () => {
      expect(LAPTOP_MAX_FRAME_BYTES).toBe(SERVER_MAX_FRAME_BYTES);
    });

    it("both twins match the shared fixture (wireFormat.maxFrameBytes)", () => {
      expect(LAPTOP_MAX_FRAME_BYTES).toBe(fixture.wireFormat.maxFrameBytes);
      expect(SERVER_MAX_FRAME_BYTES).toBe(fixture.wireFormat.maxFrameBytes);
    });
  });

  describe("CHANNEL_WINDOW_BYTES — the mux channel-window ceiling", () => {
    it("laptop .mjs twin matches server .ts twin", () => {
      expect(LAPTOP_CHANNEL_WINDOW_BYTES).toBe(SERVER_CHANNEL_WINDOW_BYTES);
    });

    it("both twins match the shared fixture (muxTransport.channelWindowBytes)", () => {
      expect(LAPTOP_CHANNEL_WINDOW_BYTES).toBe(fixture.muxTransport.channelWindowBytes);
      expect(SERVER_CHANNEL_WINDOW_BYTES).toBe(fixture.muxTransport.channelWindowBytes);
    });

    it("matches MAX_FRAME_BYTES, as the filter's own header comment promises — they are intentionally the same ceiling", () => {
      expect(LAPTOP_CHANNEL_WINDOW_BYTES).toBe(LAPTOP_MAX_FRAME_BYTES);
      expect(SERVER_CHANNEL_WINDOW_BYTES).toBe(SERVER_MAX_FRAME_BYTES);
    });
  });
});
