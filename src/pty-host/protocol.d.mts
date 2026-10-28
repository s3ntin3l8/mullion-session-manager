// Types for protocol.mjs, which stays plain ESM (it is copied into dist/
// verbatim and loaded by the standalone pty-host master as well as by the
// backend's attach client).
export const FRAME_DATA: 0;
export const FRAME_RESIZE: 1;
export const FRAME_EXIT: 2;
export const FRAME_HELLO: 3;
export const FRAME_VERSION: 4;
export const PROTOCOL_VERSION: number;
export const MIN_CLIENT_VERSION: number;
export const MIN_MASTER_VERSION: number;
export const TOKEN_ENV: "MULLION_PTY_HOST_TOKEN";
export function encodeHello(token: string): Buffer;
export const MAX_FRAME_BYTES: number;
export function encodeFrame(type: number, payload: Buffer): Buffer;
export function encodeResize(cols: number, rows: number): Buffer;
export function encodeExit(code: number): Buffer;
export function encodeVersion(version?: number, minClient?: number): Buffer;
export function decodeVersion(payload: Buffer): { version: number; minClient: number } | null;
export function masterCompatibility(
  announced: { version: number; minClient: number } | null,
  clientVersion?: number,
): { compatible: boolean; masterVersion: number; minClient: number };
export function createDeframer(
  onFrame: (type: number, payload: Buffer) => void,
): (chunk: Buffer) => void;
