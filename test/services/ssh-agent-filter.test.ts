import { describe, it, expect } from "vitest";
import {
  SignOnlyFilter,
  SIGN_ONLY_ALLOWLIST,
  SSH_AGENT_REQUEST_TYPE_VECTORS,
  SSH_AGENT_FAILURE_FRAME,
  SSH_AGENT_FAILURE,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  SSH_AGENTC_ADD_IDENTITY,
  SSH_AGENTC_REMOVE_IDENTITY,
  SSH_AGENTC_LOCK,
  SSH_AGENTC_EXTENSION,
  MAX_FRAME_BYTES,
} from "../../src/services/ssh-agent-filter.js";

/** Builds a real length-prefixed agent-protocol frame: 4-byte BE length +
 * type byte + arbitrary body. `body` defaults to empty, matching a bare
 * `SSH_AGENTC_REQUEST_IDENTITIES` (no payload beyond its own type byte). */
function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(4 + 1 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out.writeUInt8(type, 4);
  body.copy(out, 5);
  return out;
}

describe("ssh-agent-filter", () => {
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

    it("derives SIGN_ONLY_ALLOWLIST from the vectors, not as a separately-maintained list", () => {
      expect(SIGN_ONLY_ALLOWLIST.size).toBe(2);
      expect(SIGN_ONLY_ALLOWLIST.has(SSH_AGENTC_REQUEST_IDENTITIES)).toBe(true);
      expect(SIGN_ONLY_ALLOWLIST.has(SSH_AGENTC_SIGN_REQUEST)).toBe(true);
    });

    it("SSH_AGENT_FAILURE_FRAME is a well-formed length-1 frame carrying exactly SSH_AGENT_FAILURE", () => {
      expect(SSH_AGENT_FAILURE_FRAME).toEqual(Buffer.from([0, 0, 0, 1, SSH_AGENT_FAILURE]));
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
      const result = f.feed(frame(SSH_AGENTC_ADD_IDENTITY, Buffer.from("private-key-material")));
      expect(result.forward).toHaveLength(0);
      expect(result.reject).toEqual([SSH_AGENT_FAILURE_FRAME]);
    });

    it("blocks an unrecognized/future message type not present in the table at all — default-deny, not default-allow", () => {
      const f = new SignOnlyFilter();
      const result = f.feed(frame(200));
      expect(result.forward).toHaveLength(0);
      expect(result.reject).toEqual([SSH_AGENT_FAILURE_FRAME]);
    });

    it("blocks a zero-length body (no type byte to classify) without throwing", () => {
      const malformed = Buffer.from([0, 0, 0, 0]); // length=0, no body at all — a complete, if malformed, frame
      const result = new SignOnlyFilter().feed(malformed);
      expect(result.forward).toHaveLength(0);
      expect(result.reject).toEqual([SSH_AGENT_FAILURE_FRAME]);
    });

    it("reassembles a frame split across multiple feed() calls, yielding nothing until it's complete", () => {
      const f = new SignOnlyFilter();
      const input = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("split-me-across-calls"));

      const first = f.feed(input.subarray(0, 3)); // not even the full length prefix yet
      expect(first.forward).toHaveLength(0);
      expect(first.reject).toHaveLength(0);

      const second = f.feed(input.subarray(3, 10)); // length prefix + type + a few payload bytes
      expect(second.forward).toHaveLength(0);
      expect(second.reject).toHaveLength(0);

      const third = f.feed(input.subarray(10));
      expect(third.forward).toEqual([input]);
      expect(third.reject).toHaveLength(0);
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
      // The partial tail must still be buffered internally — completing it
      // on the next call should yield the second frame, not re-emit or
      // lose the first.
      const rest = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("later")).subarray(4);
      const followUp = f.feed(rest);
      expect(followUp.forward).toEqual([frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("later"))]);
    });

    it("throws on a declared body length exceeding MAX_FRAME_BYTES, rather than buffering unboundedly", () => {
      const f = new SignOnlyFilter();
      const hostile = Buffer.alloc(4);
      hostile.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      expect(() => f.feed(hostile)).toThrow(/exceeds the/);
    });

    it("accepts a body length exactly at MAX_FRAME_BYTES without throwing", () => {
      const f = new SignOnlyFilter();
      const input = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.alloc(MAX_FRAME_BYTES - 1));
      expect(() => f.feed(input)).not.toThrow();
    });
  });
});
