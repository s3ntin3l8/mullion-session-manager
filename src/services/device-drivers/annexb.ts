import type { DeviceVideoPacket } from "./types.js";

// Annex-B H.264 handling for the iOS Simulator driver: idb's `video_stream`
// delivers arbitrary gRPC chunks of one continuous Annex-B byte stream (a
// chunk is NOT a NAL), and the panel's decoder wants whole NALs framed as
// `DeviceVideoPacket`s (see docs/spikes/ios-simulator-idb.md).

const START_CODE = Uint8Array.of(0, 0, 0, 1);

/** Largest single NAL the splitter will accumulate before it assumes it lost
 * sync and resynchronises on the next start code. */
const MAX_NAL_BYTES = 8 * 1024 * 1024;

/** Default cap of the GOP buffer. */
export const GOP_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

/** The `nal_unit_type` of a NAL (its first byte, without a start code). */
export function nalType(nal: Uint8Array): number {
  return (nal[0] ?? 0) & 0x1f;
}

/**
 * Incremental Annex-B splitter. `push()` takes any chunk and returns the NAL
 * units that completed with it, WITHOUT their start codes. A NAL is complete
 * only once the next start code arrives (or on `flush()`), so the last NAL of
 * a chunk is held back. Both 3- and 4-byte start codes are recognised; the
 * leading zero of a 4-byte code (and any `trailing_zero_8bits`) is not part of
 * the preceding NAL. Bytes before the first start code are dropped.
 */
export class AnnexBSplitter {
  /** Bytes of the NAL being accumulated (after its start code), or, before the
   * first start code, the last two bytes seen so a split code is found. */
  private pending: Buffer = Buffer.alloc(0);
  private inNal = false;
  /** Index in `pending` the next start-code search begins at. */
  private scanFrom = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length === 0) return [];
    this.pending =
      this.pending.length === 0
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.concat([this.pending, chunk]);
    const out: Uint8Array[] = [];
    let nalStart = this.inNal ? 0 : -1;
    for (;;) {
      const idx = findStartCode(this.pending, this.scanFrom);
      if (idx < 0) break;
      if (this.inNal || nalStart >= 0) {
        const nal = trimTrailingZeros(this.pending.subarray(nalStart, idx));
        // Copied: `pending` is re-sliced below and the chunk may be reused.
        if (nal.length > 0) out.push(Uint8Array.from(nal));
      }
      this.inNal = true;
      nalStart = idx + 3;
      this.scanFrom = nalStart;
    }
    if (nalStart >= 0) {
      if (nalStart > 0) this.pending = Buffer.from(this.pending.subarray(nalStart));
      this.scanFrom = Math.max(0, this.pending.length - 2);
    } else {
      // No start code yet: keep only a tail that could begin one.
      this.pending = Buffer.from(this.pending.subarray(Math.max(0, this.pending.length - 2)));
      this.scanFrom = 0;
    }
    if (this.inNal && this.pending.length > MAX_NAL_BYTES) this.reset();
    return out;
  }

  /** Emits the NAL still being accumulated (end of stream) and resets. */
  flush(): Uint8Array[] {
    const nal = this.inNal ? trimTrailingZeros(this.pending) : Buffer.alloc(0);
    this.reset();
    return nal.length > 0 ? [Uint8Array.from(nal)] : [];
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.inNal = false;
    this.scanFrom = 0;
  }
}

function findStartCode(buf: Buffer, from: number): number {
  for (let i = Math.max(0, from); i + 2 < buf.length; i++) {
    if (buf[i + 2]! > 1) {
      // Neither byte i+2 nor the two before it can end a 00 00 01: skip ahead.
      i += 2;
    } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      return i;
    }
  }
  return -1;
}

function trimTrailingZeros(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.subarray(0, end);
}

function withStartCode(...nals: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const n of nals) size += START_CODE.length + n.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const n of nals) {
    out.set(START_CODE, off);
    out.set(n, off + START_CODE.length);
    off += START_CODE.length + n.length;
  }
  return out;
}

/**
 * Turns idb's chunks into `DeviceVideoPacket`s: SPS+PPS (4-byte start codes)
 * as one `configuration` packet, an IDR as a `data` packet with
 * `keyframe: true`, every other slice as a `data` packet. Anything before the
 * first IDR that is not parameter sets is dropped, and nothing is emitted that
 * a decoder could not decode: an IDR (and the slices after it) that arrives
 * before SPS+PPS is held until they do. Other NAL types (SEI, AUD) are dropped.
 */
export class AnnexBPacketizer {
  private readonly splitter = new AnnexBSplitter();
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  /** True once a configuration packet has been emitted for the current SPS/PPS. */
  private configured = false;
  /** True once an IDR has been emitted: later slices are decodable. */
  private haveKeyframe = false;
  /** NALs (an IDR first) that arrived before the configuration did. */
  private held: Uint8Array[] = [];
  private heldBytes = 0;

  constructor(private readonly maxHeldBytes = MAX_NAL_BYTES) {}

  push(chunk: Uint8Array): DeviceVideoPacket[] {
    const out: DeviceVideoPacket[] = [];
    for (const nal of this.splitter.push(chunk)) this.onNal(nal, out);
    return out;
  }

  /** Emits what a final `flush()` of the splitter completes. */
  flush(): DeviceVideoPacket[] {
    const out: DeviceVideoPacket[] = [];
    for (const nal of this.splitter.flush()) this.onNal(nal, out);
    return out;
  }

  private onNal(nal: Uint8Array, out: DeviceVideoPacket[]): void {
    switch (nalType(nal)) {
      case NAL_SPS:
        // A new parameter-set run: PPS must follow before anything decodes.
        this.sps = nal;
        this.pps = null;
        this.configured = false;
        return;
      case NAL_PPS:
        if (!this.sps) return;
        this.pps = nal;
        this.configured = true;
        out.push({ type: "configuration", data: withStartCode(this.sps, this.pps) });
        this.releaseHeld(out);
        return;
      case NAL_IDR:
        if (!this.configured) {
          // Held, not emitted: a new IDR supersedes an older held one.
          this.held = [nal];
          this.heldBytes = nal.length;
          return;
        }
        this.haveKeyframe = true;
        out.push({ type: "data", keyframe: true, data: withStartCode(nal) });
        return;
      case NAL_SLICE:
        if (!this.configured) {
          if (this.held.length === 0) return;
          this.heldBytes += nal.length;
          if (this.heldBytes > this.maxHeldBytes) {
            this.held = [];
            this.heldBytes = 0;
            return;
          }
          this.held.push(nal);
          return;
        }
        if (this.haveKeyframe) out.push({ type: "data", data: withStartCode(nal) });
        return;
      default:
        return;
    }
  }

  private releaseHeld(out: DeviceVideoPacket[]): void {
    const held = this.held;
    this.held = [];
    this.heldBytes = 0;
    // A fresh configuration starts a fresh decode run: only an IDR can open it.
    this.haveKeyframe = false;
    for (const nal of held) this.onNal(nal, out);
  }
}

/**
 * The codec configuration plus the last IDR and every slice since it, so a
 * late subscriber decodes at once (a cached IDR alone does not decode against
 * later deltas). Bounded: when a GOP outgrows the cap its frames are dropped
 * and nothing is kept until the next IDR starts a fresh GOP.
 */
export class GopBuffer {
  private config: DeviceVideoPacket | null = null;
  private frames: DeviceVideoPacket[] = [];
  private bytes = 0;
  /** True while the current GOP overflowed: deltas are dropped until an IDR. */
  private overflowed = false;

  constructor(private readonly maxBytes = GOP_BUFFER_MAX_BYTES) {}

  push(packet: DeviceVideoPacket): void {
    if (packet.type === "configuration") {
      this.config = packet;
      // Frames of an older configuration do not decode against the new one.
      this.frames = [];
      this.bytes = 0;
      this.overflowed = false;
      return;
    }
    if (packet.keyframe) {
      this.frames = [];
      this.bytes = 0;
      this.overflowed = false;
    } else if (this.frames.length === 0 || this.overflowed) {
      // No IDR to hang a delta on (or its GOP was dropped).
      return;
    }
    if (this.bytes + packet.data.length > this.maxBytes) {
      this.frames = [];
      this.bytes = 0;
      this.overflowed = true;
      return;
    }
    this.frames.push(packet);
    this.bytes += packet.data.length;
  }

  /** Configuration, then the IDR and its deltas (whatever is decodable). */
  snapshot(): DeviceVideoPacket[] {
    return this.config ? [this.config, ...this.frames] : [];
  }

  clear(): void {
    this.config = null;
    this.frames = [];
    this.bytes = 0;
    this.overflowed = false;
  }
}
