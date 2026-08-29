// Issue #820 (round 4 PR2) — the laptop-side twin of
// test/services/ssh-agent-filter.test.ts, testing src/cli/ssh-agent-
// filter.mjs. Two layers of coverage:
//   1. Cross-checked against test/fixtures/ssh-agent-filter-vectors.json
//      (round 4 PR1's fixture) — the shared source of truth both this twin
//      AND the TS module's own tests can validate against, closing the
//      "must be mirrored by hand" drift risk ssh-agent-bridge-mux.mjs's own
//      header comment warns about (for this module, since PR1 exists).
//   2. The same behavioral coverage test/services/ssh-agent-filter.test.ts
//      already has (byte-for-byte forwarding, edge cases, buffer-reuse
//      safety) — ported by hand since the two SignOnlyFilter
//      implementations are deliberately separate, not shared.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SignOnlyFilter,
  SshAgentFrameTooLargeError,
  SIGN_ONLY_ALLOWLIST,
  SSH_AGENT_REQUEST_TYPE_VECTORS,
  SSH_AGENT_FAILURE_FRAME,
  SSH_AGENT_FAILURE,
  LENGTH_PREFIX_BYTES,
  MAX_FRAME_BYTES,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  SSH_AGENTC_ADD_IDENTITY,
  SSH_AGENTC_REMOVE_IDENTITY,
  SSH_AGENTC_LOCK,
  SSH_AGENTC_EXTENSION,
  SSH_AGENTC_ADD_RSA_IDENTITY,
  SSH_AGENTC_REMOVE_RSA_IDENTITY,
  SSH_AGENTC_REMOVE_ALL_RSA_IDENTITIES,
} from "../../src/cli/ssh-agent-filter.mjs";

const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/ssh-agent-filter-vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/** Builds a real length-prefixed agent-protocol frame — same helper as
 * test/services/ssh-agent-filter.test.ts's own `frame()`. */
function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(4 + 1 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out.writeUInt8(type, 4);
  body.copy(out, 5);
  return out;
}

describe("ssh-agent-filter.mjs (laptop-side twin)", () => {
  describe("against the shared conformance fixture (round 4 PR1)", () => {
    it("this module's own table matches the fixture exactly — every vector, in order", () => {
      expect(SSH_AGENT_REQUEST_TYPE_VECTORS).toEqual(fixture.vectors);
    });

    it("agrees with the fixture's wire-format constants", () => {
      expect(LENGTH_PREFIX_BYTES).toBe(fixture.wireFormat.lengthPrefixBytes);
      expect(MAX_FRAME_BYTES).toBe(fixture.wireFormat.maxFrameBytes);
    });

    it("agrees with the fixture's SSH_AGENT_FAILURE frame", () => {
      expect(SSH_AGENT_FAILURE).toBe(fixture.sshAgentFailure.type);
      expect(SSH_AGENT_FAILURE_FRAME.toString("hex")).toBe(fixture.sshAgentFailure.frameHex);
    });

    it("defaults to blocked for a type absent from the fixture's own vectors, matching defaultAllowed: false", () => {
      expect(fixture.defaultAllowed).toBe(false);
      const typesInFixture = new Set(fixture.vectors.map((v: { type: number }) => v.type));
      expect(typesInFixture.has(200)).toBe(false);
      const f = new SignOnlyFilter();
      const result = f.feed(frame(200));
      expect(result.forward).toHaveLength(0);
      expect(result.reject).toEqual([SSH_AGENT_FAILURE_FRAME]);
    });
  });

  describe("the conformance table itself", () => {
    it("allows exactly REQUEST_IDENTITIES and SIGN_REQUEST, and blocks everything else it lists", () => {
      const allowed = SSH_AGENT_REQUEST_TYPE_VECTORS.filter((v) => v.allowed).map((v) => v.type);
      expect(allowed.sort((a, b) => a - b)).toEqual(
        [SSH_AGENTC_REQUEST_IDENTITIES, SSH_AGENTC_SIGN_REQUEST].sort((a, b) => a - b),
      );
      const blocked = SSH_AGENT_REQUEST_TYPE_VECTORS.filter((v) => !v.allowed).map((v) => v.type);
      expect(blocked).toContain(SSH_AGENTC_ADD_IDENTITY);
      expect(blocked).toContain(SSH_AGENTC_REMOVE_IDENTITY);
      expect(blocked).toContain(SSH_AGENTC_LOCK);
      expect(blocked).toContain(SSH_AGENTC_EXTENSION);
    });

    it("includes the legacy v1 mutating types, not just the modern ones", () => {
      const blocked = SSH_AGENT_REQUEST_TYPE_VECTORS.filter((v) => !v.allowed).map((v) => v.type);
      expect(blocked).toContain(SSH_AGENTC_ADD_RSA_IDENTITY);
      expect(blocked).toContain(SSH_AGENTC_REMOVE_RSA_IDENTITY);
      expect(blocked).toContain(SSH_AGENTC_REMOVE_ALL_RSA_IDENTITIES);
    });

    it("derives SIGN_ONLY_ALLOWLIST from the vectors, not as a separately-maintained list", () => {
      expect(SIGN_ONLY_ALLOWLIST.size).toBe(2);
      expect(SIGN_ONLY_ALLOWLIST.has(SSH_AGENTC_REQUEST_IDENTITIES)).toBe(true);
      expect(SIGN_ONLY_ALLOWLIST.has(SSH_AGENTC_SIGN_REQUEST)).toBe(true);
    });
  });

  describe("SignOnlyFilter.feed()", () => {
    it("forwards an allowed frame (REQUEST_IDENTITIES, no payload) unmodified", () => {
      const f = new SignOnlyFilter();
      const input = frame(SSH_AGENTC_REQUEST_IDENTITIES);
      const result = f.feed(input);
      expect(result.forward).toHaveLength(1);
      expect(result.forward[0]).toEqual(input);
      expect(result.reject).toHaveLength(0);
    });

    it("forwards an allowed frame with a real payload (SIGN_REQUEST) unmodified, byte for byte", () => {
      const f = new SignOnlyFilter();
      const payload = Buffer.from("fake-pubkey-blob+data-to-sign");
      const input = frame(SSH_AGENTC_SIGN_REQUEST, payload);
      const result = f.feed(input);
      expect(result.forward[0]).toEqual(input);
      expect(result.reject).toHaveLength(0);
    });

    it("blocks a mutating request (ADD_IDENTITY) and synthesizes exactly one SSH_AGENT_FAILURE reply, never forwarding it", () => {
      const f = new SignOnlyFilter();
      const blocked = frame(SSH_AGENTC_ADD_IDENTITY, Buffer.from("private-key-material"));
      const result = f.feed(blocked);
      expect(result.forward).toHaveLength(0);
      expect(result.reject).toEqual([SSH_AGENT_FAILURE_FRAME]);
      expect(result.rejectedLengths).toEqual([blocked.length]);
    });

    it("rejectedLengths stays parallel to reject across a mix of differently-sized blocked frames in one feed() call", () => {
      const f = new SignOnlyFilter();
      const small = frame(SSH_AGENTC_LOCK);
      const large = frame(SSH_AGENTC_ADD_IDENTITY, Buffer.alloc(5000, 7));
      const result = f.feed(Buffer.concat([small, large]));
      expect(result.reject).toEqual([SSH_AGENT_FAILURE_FRAME, SSH_AGENT_FAILURE_FRAME]);
      expect(result.rejectedLengths).toEqual([small.length, large.length]);
    });

    it("blocks a zero-length body (no type byte to classify) without throwing", () => {
      const malformed = Buffer.from([0, 0, 0, 0]);
      const result = new SignOnlyFilter().feed(malformed);
      expect(result.forward).toHaveLength(0);
      expect(result.reject).toEqual([SSH_AGENT_FAILURE_FRAME]);
    });

    it("reassembles a frame split across multiple feed() calls, yielding nothing until it's complete", () => {
      const f = new SignOnlyFilter();
      const input = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("split-me-across-calls"));

      const first = f.feed(input.subarray(0, 3));
      expect(first.forward).toHaveLength(0);
      expect(first.reject).toHaveLength(0);

      const second = f.feed(input.subarray(3, 10));
      expect(second.forward).toHaveLength(0);
      expect(second.reject).toHaveLength(0);

      const third = f.feed(input.subarray(10));
      expect(third.forward).toEqual([input]);
      expect(third.reject).toHaveLength(0);
    });

    it("reassembles a frame trickled one byte at a time", () => {
      const f = new SignOnlyFilter();
      const input = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("one-byte-at-a-time"));

      let result;
      for (let i = 0; i < input.length - 1; i++) {
        result = f.feed(input.subarray(i, i + 1));
        expect(result.forward).toHaveLength(0);
        expect(result.reject).toHaveLength(0);
      }
      result = f.feed(input.subarray(input.length - 1));
      expect(result!.forward).toEqual([input]);
    });

    it("returned frames stay valid after later feed() calls — the reused internal buffer must not corrupt an already-returned frame", () => {
      const f = new SignOnlyFilter();
      const first = frame(SSH_AGENTC_REQUEST_IDENTITIES);
      const firstResult = f.feed(first);
      const returnedFrame = firstResult.forward[0];
      const snapshot = Buffer.from(returnedFrame);

      for (let i = 0; i < 20; i++) {
        f.feed(frame(SSH_AGENTC_SIGN_REQUEST, Buffer.alloc(1000, i)));
      }

      expect(returnedFrame).toEqual(snapshot);
    });

    it("classifies multiple frames delivered in a single chunk, preserving order", () => {
      const f = new SignOnlyFilter();
      const allowed1 = frame(SSH_AGENTC_REQUEST_IDENTITIES);
      const blocked = frame(SSH_AGENTC_REMOVE_IDENTITY);
      const allowed2 = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("x"));
      const combined = Buffer.concat([allowed1, blocked, allowed2]);

      const result = f.feed(combined);
      expect(result.forward).toEqual([allowed1, allowed2]);
      expect(result.reject).toEqual([SSH_AGENT_FAILURE_FRAME]);
    });

    it("retains a trailing partial frame across a feed() call that yields zero complete frames", () => {
      const f = new SignOnlyFilter();
      const complete = frame(SSH_AGENTC_REQUEST_IDENTITIES);
      const partialNext = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("later")).subarray(0, 4);

      const result = f.feed(Buffer.concat([complete, partialNext]));
      expect(result.forward).toEqual([complete]);
      expect(result.reject).toHaveLength(0);

      const rest = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("later")).subarray(4);
      const followUp = f.feed(rest);
      expect(followUp.forward).toEqual([frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("later"))]);
    });

    it("throws SshAgentFrameTooLargeError on a declared body length exceeding MAX_FRAME_BYTES, rather than buffering unboundedly", () => {
      const f = new SignOnlyFilter();
      const hostile = Buffer.alloc(4);
      hostile.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      expect(() => f.feed(hostile)).toThrow(SshAgentFrameTooLargeError);
      expect(() => f.feed(hostile)).toThrow(/exceeds the/);
    });

    it("accepts a body length exactly at MAX_FRAME_BYTES without throwing", () => {
      const f = new SignOnlyFilter();
      const input = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.alloc(MAX_FRAME_BYTES - 1));
      expect(() => f.feed(input)).not.toThrow();
    });

    it("preserves an already-classified ALLOWED frame on the thrown error's partialResult, rather than silently discarding it", () => {
      const f = new SignOnlyFilter();
      const allowed = frame(SSH_AGENTC_REQUEST_IDENTITIES);
      const hostileLength = Buffer.alloc(4);
      hostileLength.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      const chunk = Buffer.concat([allowed, hostileLength]);

      let caught: unknown;
      try {
        f.feed(chunk);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SshAgentFrameTooLargeError);
      const err = caught as InstanceType<typeof SshAgentFrameTooLargeError>;
      expect(err.partialResult.forward).toEqual([allowed]);
      expect(err.partialResult.reject).toHaveLength(0);
    });

    it("preserves an already-classified BLOCKED frame's synthesized failure reply on partialResult under the same condition", () => {
      const f = new SignOnlyFilter();
      const blocked = frame(SSH_AGENTC_ADD_IDENTITY);
      const hostileLength = Buffer.alloc(4);
      hostileLength.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      const chunk = Buffer.concat([blocked, hostileLength]);

      let caught: unknown;
      try {
        f.feed(chunk);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SshAgentFrameTooLargeError);
      const err = caught as InstanceType<typeof SshAgentFrameTooLargeError>;
      expect(err.partialResult.forward).toHaveLength(0);
      expect(err.partialResult.reject).toEqual([SSH_AGENT_FAILURE_FRAME]);
    });
  });
});
