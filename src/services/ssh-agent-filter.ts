// Issue #820 — the sign-only filter: a compromised or malicious primary
// (or a bug anywhere in the mux/routes wiring between it and the laptop)
// must not be able to mutate the laptop's SSH agent — only ask it to list
// identities or produce a signature. Enforced HERE, on the laptop side,
// which is authoritative (this module runs on whichever end owns the real
// agent socket); a second instance running primary-side is defense in
// depth, not the security boundary itself.
//
// This module only ever classifies REQUESTS (the client->agent direction,
// SSH_AGENTC_* below) — the real agent's own REPLIES (SSH_AGENT_* success/
// failure/identity-answer/sign-response) are always relayed unfiltered in
// the other direction. They originate from something already trusted (the
// real local agent, only ever replying to a request this filter already
// let through), so there is nothing for a reply-direction filter to guard
// against.
//
// Wire format (draft-miller-ssh-agent, the protocol OpenSSH/1Password/
// every real ssh-agent speaks): each message is a 4-byte big-endian length
// prefix followed by that many bytes of body, whose first byte is the
// message type. Framing here deliberately mirrors ssh-agent-mux.ts's own
// decodeFrame — fixed-width header, fail-closed on anything malformed —
// but is a distinct length-prefixed format (SSH agent protocol's own),
// not this repo's mux frame format; the two must not be conflated.
//
// What this filter does NOT do (Hermes review, PR #856): allowing
// SSH_AGENTC_SIGN_REQUEST through means a compromised or malicious primary
// can still ask to sign arbitrary data with any loaded key — this module's
// job is stopping MUTATION (add/remove/lock a key), not gating signing
// itself. Per-signature authorization is the agent's own responsibility,
// via whatever confirmation constraint the key was loaded with. Operators
// who want a human-in-the-loop check on every signature, not just on key
// load, should load keys with `ssh-add -c` (or 1Password's equivalent
// per-use approval setting, see docs/ssh-agent.md) — loading a key WITHOUT
// per-use confirmation means "list identities + sign" alone is enough for
// a compromised primary to sign with it, unconfirmed, defeating a
// confirm-on-add-only setup. This module cannot detect or enforce that
// choice from here; it's a laptop-side agent configuration decision this
// filter's existence doesn't change.

const LENGTH_PREFIX_BYTES = 4;

/** Ceiling on a single agent-protocol frame's declared body length. A real
 * frame (a public key blob, a signature, flags) is at most a few KB;
 * `ssh-keygen -Y sign` and friends hash large inputs client-side and only
 * ever send the digest to the agent, not the original data. Matched to
 * `CHANNEL_WINDOW_BYTES` (ssh-agent-mux.ts) as a sensible, generous
 * ceiling — this bounds how much of an unterminated/hostile length prefix
 * this module will buffer before refusing to continue, not a tuned
 * protocol limit. */
export const MAX_FRAME_BYTES = 256 * 1024;

// SSH_AGENTC_* — client REQUEST message types this filter classifies.
export const SSH_AGENTC_REQUEST_RSA_IDENTITIES = 1; // legacy v1 protocol
export const SSH_AGENTC_ADD_RSA_IDENTITY = 7; // legacy v1, mutating
export const SSH_AGENTC_REMOVE_RSA_IDENTITY = 8; // legacy v1, mutating
export const SSH_AGENTC_REMOVE_ALL_RSA_IDENTITIES = 9; // legacy v1, mutating
export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENTC_ADD_IDENTITY = 17;
export const SSH_AGENTC_REMOVE_IDENTITY = 18;
export const SSH_AGENTC_REMOVE_ALL_IDENTITIES = 19;
export const SSH_AGENTC_ADD_SMARTCARD_KEY = 20;
export const SSH_AGENTC_REMOVE_SMARTCARD_KEY = 21;
export const SSH_AGENTC_LOCK = 22;
export const SSH_AGENTC_UNLOCK = 23;
export const SSH_AGENTC_ADD_RSA_ID_CONSTRAINED = 24; // legacy v1
export const SSH_AGENTC_ADD_ID_CONSTRAINED = 25;
export const SSH_AGENTC_ADD_SMARTCARD_KEY_CONSTRAINED = 26;
export const SSH_AGENTC_EXTENSION = 27;

/** The single reply this filter ever synthesizes. Sent in place of relaying
 * a blocked request to the real agent — never a reply the real agent
 * itself produced. */
export const SSH_AGENT_FAILURE = 5;

/**
 * The conformance table: every known `SSH_AGENTC_*` request type mapped to
 * its allow/block decision and a human name. Exported as plain,
 * JSON-serializable data — not just baked into `SIGN_ONLY_ALLOWLIST` below
 * — specifically so a second implementation (the laptop tray app, in a
 * separate repo per the design plan, likely not TypeScript) can test
 * itself against this exact table rather than re-deriving the allowlist
 * from prose. This is the single source of truth; `SIGN_ONLY_ALLOWLIST` is
 * derived from it, not maintained separately, so the two can't drift.
 *
 * Only `SSH_AGENTC_REQUEST_IDENTITIES` and `SSH_AGENTC_SIGN_REQUEST` are
 * allowed — everything else (in particular every ADD_IDENTITY, REMOVE_*,
 * LOCK, UNLOCK, and EXTENSION message) is blocked, INCLUDING types not
 * listed here at all: `classify()` below defaults to blocked for any type
 * absent from this table, so a future/vendor/unrecognized message type is
 * refused by default rather than accidentally let through.
 */
export interface SshAgentMessageTypeVector {
  type: number;
  name: string;
  allowed: boolean;
}

export const SSH_AGENT_REQUEST_TYPE_VECTORS: readonly SshAgentMessageTypeVector[] = [
  {
    type: SSH_AGENTC_REQUEST_RSA_IDENTITIES,
    name: "SSH_AGENTC_REQUEST_RSA_IDENTITIES",
    allowed: false,
  },
  { type: SSH_AGENTC_ADD_RSA_IDENTITY, name: "SSH_AGENTC_ADD_RSA_IDENTITY", allowed: false },
  { type: SSH_AGENTC_REMOVE_RSA_IDENTITY, name: "SSH_AGENTC_REMOVE_RSA_IDENTITY", allowed: false },
  {
    type: SSH_AGENTC_REMOVE_ALL_RSA_IDENTITIES,
    name: "SSH_AGENTC_REMOVE_ALL_RSA_IDENTITIES",
    allowed: false,
  },
  { type: SSH_AGENTC_REQUEST_IDENTITIES, name: "SSH_AGENTC_REQUEST_IDENTITIES", allowed: true },
  { type: SSH_AGENTC_SIGN_REQUEST, name: "SSH_AGENTC_SIGN_REQUEST", allowed: true },
  { type: SSH_AGENTC_ADD_IDENTITY, name: "SSH_AGENTC_ADD_IDENTITY", allowed: false },
  { type: SSH_AGENTC_REMOVE_IDENTITY, name: "SSH_AGENTC_REMOVE_IDENTITY", allowed: false },
  {
    type: SSH_AGENTC_REMOVE_ALL_IDENTITIES,
    name: "SSH_AGENTC_REMOVE_ALL_IDENTITIES",
    allowed: false,
  },
  { type: SSH_AGENTC_ADD_SMARTCARD_KEY, name: "SSH_AGENTC_ADD_SMARTCARD_KEY", allowed: false },
  {
    type: SSH_AGENTC_REMOVE_SMARTCARD_KEY,
    name: "SSH_AGENTC_REMOVE_SMARTCARD_KEY",
    allowed: false,
  },
  { type: SSH_AGENTC_LOCK, name: "SSH_AGENTC_LOCK", allowed: false },
  { type: SSH_AGENTC_UNLOCK, name: "SSH_AGENTC_UNLOCK", allowed: false },
  {
    type: SSH_AGENTC_ADD_RSA_ID_CONSTRAINED,
    name: "SSH_AGENTC_ADD_RSA_ID_CONSTRAINED",
    allowed: false,
  },
  { type: SSH_AGENTC_ADD_ID_CONSTRAINED, name: "SSH_AGENTC_ADD_ID_CONSTRAINED", allowed: false },
  {
    type: SSH_AGENTC_ADD_SMARTCARD_KEY_CONSTRAINED,
    name: "SSH_AGENTC_ADD_SMARTCARD_KEY_CONSTRAINED",
    allowed: false,
  },
  { type: SSH_AGENTC_EXTENSION, name: "SSH_AGENTC_EXTENSION", allowed: false },
];

export const SIGN_ONLY_ALLOWLIST: ReadonlySet<number> = new Set(
  SSH_AGENT_REQUEST_TYPE_VECTORS.filter((v) => v.allowed).map((v) => v.type),
);

function classify(type: number): boolean {
  return SIGN_ONLY_ALLOWLIST.has(type);
}

/** The exact bytes of a synthesized `SSH_AGENT_FAILURE` reply: a 4-byte
 * length prefix of `1`, followed by the single type byte. Precomputed
 * (rather than built per-call) since it's always identical — the reply
 * never needs to reference which request triggered it. */
export const SSH_AGENT_FAILURE_FRAME: Buffer = Buffer.from([0, 0, 0, 1, SSH_AGENT_FAILURE]);

export interface FilterResult {
  /** Raw bytes of ALLOWED frames, in stream order, to relay UNMODIFIED to
   * the real agent socket. */
  forward: Buffer[];
  /** One `SSH_AGENT_FAILURE_FRAME` per BLOCKED (or unparseable) frame
   * encountered, in stream order — send these back to the requester
   * directly. These frames must never reach the real agent. */
  reject: Buffer[];
}

/**
 * Thrown by `SignOnlyFilter.feed()` on an oversized declared frame length
 * (see its own doc). Carries `partialResult` — whatever frames were
 * already classified earlier in the SAME `feed()` call, before the
 * oversized frame was reached (review finding: an earlier version threw a
 * plain `Error` here, silently discarding those without returning them —
 * fail-*safe* in the sense that nothing unsafe was forwarded, but a real
 * functional gap, since a legitimate request that happened to precede a
 * hostile frame in the same chunk would just vanish with no way for the
 * caller to recover it). Most callers should still just close the
 * connection on catching this (see `feed()`'s own doc) — `partialResult`
 * exists so that choice is explicit and available, not so every caller is
 * expected to salvage it. */
export class SshAgentFrameTooLargeError extends Error {
  constructor(
    readonly bodyLength: number,
    readonly partialResult: FilterResult,
  ) {
    super(
      `ssh-agent-filter: frame body length ${bodyLength} exceeds the ` +
        `${MAX_FRAME_BYTES}-byte limit — malformed or hostile input, refusing to continue`,
    );
    this.name = "SshAgentFrameTooLargeError";
  }
}

/**
 * Reassembles length-prefixed SSH-agent-protocol frames out of an
 * arbitrary byte-chunk stream (a frame can split across multiple `feed()`
 * calls, or several frames can arrive in one chunk — this module makes no
 * assumption about chunk boundaries aligning with frame boundaries, same
 * posture as `ssh-agent-mux.ts`'s own frame decoding) and classifies each
 * complete frame as allowed or blocked per `SIGN_ONLY_ALLOWLIST`.
 *
 * One instance per connection to filter — it holds partial-frame state
 * across calls, so instances must not be shared or reused across
 * unrelated byte streams.
 */
export class SignOnlyFilter {
  // `buffer` is a reused, over-allocated backing store — `length` tracks
  // how many of its leading bytes are actually valid data; the rest is
  // spare capacity. NOT a plain "concat the new chunk on every feed()"
  // buffer (Hermes review, PR #856): that approach re-copies the ENTIRE
  // accumulated buffer on every single call, since `Buffer.concat`
  // produces a fresh, exactly-sized result each time — for a frame
  // trickled in one byte at a time up to `MAX_FRAME_BYTES`, that's the
  // classic repeated-concat pitfall, O(n²) total copying for n bytes of
  // final size (a real, attacker-triggerable CPU-burn vector per
  // connection, not just a style nitpick, even though bounded to one
  // MAX_FRAME_BYTES-sized frame per instance). `append()` below instead
  // grows capacity geometrically (double, like a standard dynamic array),
  // so appends are amortized O(1) each — total work across reassembling
  // one frame is O(frame size), not O(frame size²).
  private buffer: Buffer = Buffer.alloc(0);
  private length = 0;

  private append(chunk: Buffer): void {
    const needed = this.length + chunk.length;
    if (needed > this.buffer.length) {
      const grown = Buffer.allocUnsafe(Math.max(needed, this.buffer.length * 2, 64));
      this.buffer.copy(grown, 0, 0, this.length);
      this.buffer = grown;
    }
    chunk.copy(this.buffer, this.length);
    this.length += chunk.length;
  }

  /** Shifts whatever's left after extracting a frame down to the front of
   * `buffer`, so the next `append()` keeps writing after genuinely-live
   * data rather than stale bytes a prior frame already consumed. */
  private consume(frameLength: number): void {
    this.buffer.copy(this.buffer, 0, frameLength, this.length);
    this.length -= frameLength;
  }

  /**
   * Feed newly-arrived bytes from an untrusted requester. Returns however
   * many complete frames the accumulated buffer now contains, classified
   * into `forward`/`reject`; any trailing partial frame is retained
   * internally for the next call.
   *
   * Throws `SshAgentFrameTooLargeError` if a frame's declared body length
   * exceeds `MAX_FRAME_BYTES` — this is fail-closed by design (the caller
   * should close the underlying connection on catching it, the same way
   * any other protocol violation would be handled), not something to
   * silently cap or truncate, since a length prefix this module can't
   * trust the declared size of is not a frame it can safely continue
   * parsing at all. See `SshAgentFrameTooLargeError`'s own doc for why the
   * thrown error carries whatever this call had already classified before
   * hitting the oversized frame, rather than discarding it.
   */
  feed(chunk: Buffer): FilterResult {
    this.append(chunk);
    const forward: Buffer[] = [];
    const reject: Buffer[] = [];

    for (;;) {
      if (this.length < LENGTH_PREFIX_BYTES) break;
      const bodyLength = this.buffer.readUInt32BE(0);
      if (bodyLength > MAX_FRAME_BYTES) {
        throw new SshAgentFrameTooLargeError(bodyLength, { forward, reject });
      }
      const frameLength = LENGTH_PREFIX_BYTES + bodyLength;
      if (this.length < frameLength) break; // incomplete — wait for more bytes

      // Copied out, NOT a bare `subarray` view (unlike the previous,
      // never-mutated-in-place version of this buffer): `this.buffer` is
      // now a reused backing store that `append`/`consume` write into and
      // shift in place, so a view into it would go stale — silently
      // corrupted by whatever gets written there next — the moment a
      // later `feed()` call runs. A returned frame must stay valid
      // independently of this instance's own internal state forever
      // after.
      const frame = Buffer.from(this.buffer.subarray(0, frameLength));
      this.consume(frameLength);

      // bodyLength === 0 is malformed (every real message has at least the
      // one type byte) — there's no type byte to read, so this can't be
      // classified as allowed. Fails closed (blocked), not thrown: unlike
      // an untrustworthy LENGTH prefix, a zero-length body is fully
      // parsed, bounded input; it doesn't risk unbounded buffering, so
      // there's no reason to tear down the connection over it the way an
      // oversized length does — just refuse it like anything else not on
      // the allowlist.
      const type = bodyLength >= 1 ? frame.readUInt8(LENGTH_PREFIX_BYTES) : -1;
      if (classify(type)) {
        forward.push(frame);
      } else {
        reject.push(SSH_AGENT_FAILURE_FRAME);
      }
    }

    return { forward, reject };
  }
}
