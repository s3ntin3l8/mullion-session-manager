// The wire protocol between a pty-host master (pty-host.mjs) and the clients
// attached to it (src/services/pty-host-client.ts) — issue #1728.
//
// Plain ESM for the same reason as everything else copied into dist/
// verbatim (see src/cli/sun-path.mjs): the master is a standalone Node
// program with no tsc step of its own, and the backend's attach client shares
// this one definition of the framing with it. Types live in protocol.d.mts.
//
// Every message, in both directions, is one frame:
//
//   [type: u8][length: u32 big-endian][payload: length bytes]
//
// Framed, rather than a raw byte stream like dtach's, because a resize has to
// travel on the same connection as the keystrokes without either one ever
// being mistaken for the other — dtach gets that from a fixed-size packet
// struct; a length prefix is the same guarantee without the size cap.

/** Terminal bytes: program output (master -> client) or input (client -> master). */
export const FRAME_DATA = 0;
/** A new terminal size, client -> master: cols u16be, rows u16be. */
export const FRAME_RESIZE = 1;
/** The program exited, master -> client: its exit code as i32be. */
export const FRAME_EXIT = 2;
/**
 * The session token, client -> master, as the client's FIRST frame. Until a
 * client has sent the right one the master tells it nothing and ignores its
 * input; a wrong one closes the connection. The token is the session's
 * gate on top of the endpoint's own OS access control — the same posture as
 * the hook and control sockets' handshake tokens (see master.mjs).
 */
export const FRAME_HELLO = 3;

/** The environment variable a master reads its session token from. */
export const TOKEN_ENV = "MULLION_PTY_HOST_TOKEN";

const HEADER_BYTES = 5;

/**
 * The largest payload a frame may declare. A peer that announces more is
 * broken or hostile, and buffering toward it would grow without bound — the
 * deframer throws instead. 16 MiB is far above any single pty read or paste.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Encodes one frame. */
export function encodeFrame(type, payload) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** A RESIZE frame for `cols` x `rows`, each clamped to the u16 range (min 1). */
export function encodeResize(cols, rows) {
  const clamp = (n) => Math.min(0xffff, Math.max(1, Math.floor(n) || 1));
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(clamp(cols), 0);
  payload.writeUInt16BE(clamp(rows), 2);
  return encodeFrame(FRAME_RESIZE, payload);
}

/** A HELLO frame carrying the session `token`. */
export function encodeHello(token) {
  return encodeFrame(FRAME_HELLO, Buffer.from(token, "utf8"));
}

/** An EXIT frame carrying `code`. */
export function encodeExit(code) {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(code, 0);
  return encodeFrame(FRAME_EXIT, payload);
}

/**
 * Returns a function that accepts raw chunks off a socket, in whatever pieces
 * they arrive, and calls `onFrame(type, payload)` once per complete frame.
 * A frame split across chunks is held until the rest arrives; several frames
 * in one chunk are all delivered.
 *
 * Throws if a frame declares a payload larger than MAX_FRAME_BYTES — the
 * caller should drop that connection.
 */
export function createDeframer(onFrame) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    while (buffered.length >= HEADER_BYTES) {
      const length = buffered.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`frame of ${length} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`);
      }
      if (buffered.length < HEADER_BYTES + length) break;
      const type = buffered.readUInt8(0);
      const payload = buffered.subarray(HEADER_BYTES, HEADER_BYTES + length);
      buffered = buffered.subarray(HEADER_BYTES + length);
      onFrame(type, payload);
    }
  };
}
