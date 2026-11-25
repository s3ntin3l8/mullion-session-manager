import { execFile } from "node:child_process";

// The `xcrun simctl` runner the iOS Simulator driver and listing share.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface SimctlOptions {
  /** Bytes written to the child's stdin (then closed). */
  input?: string;
  timeoutMs?: number;
  /** Cap on stdout; the call fails when exceeded. */
  maxBytes?: number;
  /** Receives stderr of a call that exits 0 (a failing call puts it in the
   * rejection instead). */
  onStderr?: (stderr: Buffer) => void;
}

/** Runs `xcrun simctl <args>` and resolves with stdout; rejects on a non-zero
 * exit, a timeout or an exceeded output cap. */
export type SimctlRunner = (args: string[], options?: SimctlOptions) => Promise<Buffer>;

/** The production runner: `execFile` with an argv array (never a shell), a
 * per-call timeout and an output cap. */
export const execSimctl: SimctlRunner = (args, options = {}) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      "xcrun",
      ["simctl", ...args],
      {
        encoding: "buffer",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBytes ?? DEFAULT_MAX_BYTES,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = Buffer.from(stderr ?? "")
            .toString("utf8")
            .trim();
          reject(new Error(detail ? `${err.message}: ${detail}` : err.message));
          return;
        }
        options.onStderr?.(Buffer.from(stderr ?? ""));
        resolve(Buffer.from(stdout));
      },
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
