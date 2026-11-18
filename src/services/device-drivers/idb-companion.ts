import {
  execFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createIdbGrpcClient, type IdbGrpcClient } from "./idb-grpc.js";

const UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 100;
const DEFAULT_DESCRIBE_TIMEOUT_MS = 1_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;
const STALE_POLL_INTERVAL_MS = 50;

export type IdbCompanionSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type IdbCompanionExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export interface IdbCompanionOptions {
  udid: string;
  executablePath: string;
  spawn?: IdbCompanionSpawn;
  /** Readiness timeout for start() in ms (default 15_000). */
  startTimeoutMs?: number;
  /** Poll interval between describe() readiness probes in ms (default 100). */
  readyPollIntervalMs?: number;
  /** Grace period between SIGTERM and SIGKILL in stop() in ms (default 2_000). */
  stopGraceMs?: number;
  /** Max stderr bytes retained in the diagnostic ring buffer (default 64 KiB). */
  stderrMaxBytes?: number;
  /** Override for stale-companion cleanup (defaults to ps-based matching). */
  killStaleCompanions?: (udid: string) => Promise<void>;
  /** Optional listener invoked when the companion exits unexpectedly. */
  onExit?: IdbCompanionExitListener;
}

/** Bounded byte ring buffer for child stderr diagnostics. */
export class StderrRingBuffer {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError(`invalid stderrMaxBytes: ${String(maxBytes)}`);
    }
  }

  append(chunk: Buffer | string): void {
    if (this.maxBytes === 0) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (buf.length === 0) return;

    if (buf.length >= this.maxBytes) {
      this.chunks.length = 0;
      this.chunks.push(buf.subarray(buf.length - this.maxBytes));
      this.totalBytes = this.maxBytes;
      return;
    }

    this.chunks.push(buf);
    this.totalBytes += buf.length;

    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const excess = this.totalBytes - this.maxBytes;
      const head = this.chunks[0];
      if (head.length <= excess) {
        this.chunks.shift();
        this.totalBytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.totalBytes -= excess;
      }
    }
  }

  clear(): void {
    this.chunks.length = 0;
    this.totalBytes = 0;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.totalBytes).toString("utf8");
  }
}

/** Allocates a free ephemeral TCP port on 127.0.0.1. */
export async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        if (port <= 0) {
          reject(new Error("failed to allocate loopback port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function isCompanionInvocation(tokens: string[], executablePath: string): boolean {
  if (tokens.length === 0) return false;
  const binName = path.basename(tokens[0]);
  const execBase = path.basename(executablePath);
  if (binName === "idb_companion" || tokens[0] === executablePath) {
    return true;
  }
  if (execBase && execBase !== "node" && binName === execBase) {
    return true;
  }
  // Support Node-wrapped companion scripts (such as the test fake) without
  // matching arbitrary Node processes.
  if (binName === "node" && tokens.length >= 2) {
    const script = tokens[1];
    const scriptBase = path.basename(script);
    if (
      script === executablePath ||
      (execBase && scriptBase === execBase) ||
      scriptBase.includes("idb-companion") ||
      scriptBase.includes("idb_companion")
    ) {
      return true;
    }
  }
  return false;
}

/** Parses `ps -ax -o pid=,args=` output and returns PIDs of `idb_companion`
 * processes whose argv carries the exact `--udid <udid>` argument. */
export function parseStaleCompanionPids(
  psOutput: string,
  udid: string,
  executablePath: string,
  selfPid: number = process.pid,
): number[] {
  const targetUdid = udid.toLowerCase();
  const pids: number[] = [];

  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;

    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) continue;

    const tokens = match[2].trim().split(/\s+/);
    if (!isCompanionInvocation(tokens, executablePath)) continue;

    let hasExactUdid = false;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "--udid" && i + 1 < tokens.length) {
        if (tokens[i + 1].toLowerCase() === targetUdid) {
          hasExactUdid = true;
          break;
        }
        i += 1;
      } else if (token.toLowerCase() === `--udid=${targetUdid}`) {
        hasExactUdid = true;
        break;
      }
    }

    if (hasExactUdid) {
      pids.push(pid);
    }
  }

  return pids;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function listPsProcesses(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile("ps", ["-ax", "-o", "pid=,args="], { encoding: "utf8" }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Finds and kills any leftover `idb_companion` processes for `udid` (matched
 * on the exact `--udid` argument) using SIGTERM then SIGKILL. */
export async function killStaleIdbCompanions(
  udid: string,
  executablePath: string,
  graceMs: number = DEFAULT_STOP_GRACE_MS,
): Promise<void> {
  const psOutput = await listPsProcesses();
  const pids = parseStaleCompanionPids(psOutput, udid, executablePath);
  if (pids.length === 0) return;

  for (const pid of pids) {
    sendSignal(pid, "SIGTERM");
  }

  const deadline = Date.now() + graceMs;
  let remaining = pids.filter(isPidAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(STALE_POLL_INTERVAL_MS);
    remaining = remaining.filter(isPidAlive);
  }

  for (const pid of remaining) {
    sendSignal(pid, "SIGKILL");
  }
}

const activeChildren = new Set<ChildProcess>();
let exitHookRegistered = false;

function registerChildForExitCleanup(child: ChildProcess): void {
  activeChildren.add(child);
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on("exit", () => {
      for (const active of activeChildren) {
        if (active.exitCode === null && active.signalCode === null) {
          try {
            active.kill("SIGKILL");
          } catch {
            // Process already gone.
          }
        }
      }
    });
  }
}

function unregisterChildForExitCleanup(child: ChildProcess): void {
  activeChildren.delete(child);
}

/** Manages one `idb_companion` child process for a single simulator UDID. */
export class IdbCompanion {
  readonly udid: string;
  private readonly executablePath: string;
  private readonly spawnFn: IdbCompanionSpawn;
  private readonly startTimeoutMs: number;
  private readonly readyPollIntervalMs: number;
  private readonly stopGraceMs: number;
  private readonly killStaleFn: (udid: string) => Promise<void>;
  private readonly stderrBuffer: StderrRingBuffer;
  private readonly exitListeners = new Set<IdbCompanionExitListener>();

  private child: ChildProcess | null = null;
  private currentPort: number | null = null;
  private currentClient: IdbGrpcClient | null = null;
  private exitPromise: Promise<void> | null = null;
  private stopping = false;
  private starting = false;

  constructor(options: IdbCompanionOptions) {
    if (!UDID_PATTERN.test(options.udid)) {
      throw new Error(`invalid simulator UDID: ${JSON.stringify(options.udid)}`);
    }
    if (!options.executablePath.trim()) {
      throw new Error("executablePath must not be empty");
    }
    this.udid = options.udid;
    this.executablePath = options.executablePath;
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.readyPollIntervalMs = options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.stderrBuffer = new StderrRingBuffer(options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES);
    this.killStaleFn =
      options.killStaleCompanions ??
      ((u) => killStaleIdbCompanions(u, this.executablePath, this.stopGraceMs));
    if (options.onExit) {
      this.exitListeners.add(options.onExit);
    }
  }

  get port(): number | null {
    return this.currentPort;
  }

  get client(): IdbGrpcClient | null {
    return this.currentClient;
  }

  get isRunning(): boolean {
    return (
      this.child !== null &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.stopping
    );
  }

  getStderr(): string {
    return this.stderrBuffer.toString();
  }

  onExit(listener: IdbCompanionExitListener): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.starting) {
      throw new Error(`idb_companion for ${this.udid} is already starting`);
    }
    if (this.isRunning) {
      return;
    }

    this.starting = true;
    this.stopping = false;
    this.stderrBuffer.clear();

    try {
      await this.killStaleFn(this.udid);
      const port = await allocateLoopbackPort();

      const child = this.spawnFn(
        this.executablePath,
        ["--udid", this.udid, "--grpc-port", String(port)],
        {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        },
      );

      this.child = child;
      this.currentPort = port;
      registerChildForExitCleanup(child);

      child.stdout?.on("data", () => undefined);
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.stderrBuffer.append(chunk);
      });

      let earlyExitError: Error | null = null;
      this.exitPromise = new Promise<void>((resolve) => {
        const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
          unregisterChildForExitCleanup(child);
          const wasExpected = this.stopping;
          if (this.child === child) {
            this.child = null;
            this.currentPort = null;
            this.currentClient?.close();
            this.currentClient = null;
          }
          if (!wasExpected) {
            earlyExitError = new Error(
              `idb_companion exited unexpectedly (code=${String(code)}, signal=${String(signal)})${this.formatStderrSuffix()}`,
            );
            if (!this.starting) {
              for (const listener of this.exitListeners) {
                listener(code, signal);
              }
            }
          }
          resolve();
        };
        child.once("exit", handleExit);
        child.once("error", (err) => {
          unregisterChildForExitCleanup(child);
          if (!this.stopping) {
            earlyExitError = err instanceof Error ? err : new Error(String(err));
          }
          resolve();
        });
      });

      const client = createIdbGrpcClient(port);
      this.currentClient = client;

      const deadline = Date.now() + this.startTimeoutMs;
      while (Date.now() < deadline) {
        if (earlyExitError) {
          throw earlyExitError;
        }
        if (this.stopping) {
          throw new Error(`idb_companion for ${this.udid} stopped during startup`);
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;

        try {
          const desc = await client.describe({
            timeoutMs: Math.min(DEFAULT_DESCRIBE_TIMEOUT_MS, remainingMs),
          });
          if (earlyExitError) {
            throw earlyExitError;
          }
          if (this.stopping) {
            throw new Error(`idb_companion for ${this.udid} stopped during startup`);
          }
          if (desc.target_description?.udid?.toLowerCase() !== this.udid.toLowerCase()) {
            throw new Error(
              `describe returned unexpected udid ${JSON.stringify(desc.target_description?.udid ?? null)}`,
            );
          }
          return;
        } catch (err) {
          if (earlyExitError) {
            throw earlyExitError;
          }
          if (this.stopping) {
            throw err;
          }
          const waitMs = Math.min(this.readyPollIntervalMs, Math.max(0, deadline - Date.now()));
          if (waitMs > 0) {
            await sleep(waitMs);
          }
        }
      }

      await this.killChildAndWait(child);
      throw new Error(
        `idb_companion for ${this.udid} failed to become ready within ${this.startTimeoutMs}ms${this.formatStderrSuffix()}`,
      );
    } catch (err) {
      if (this.child) {
        await this.killChildAndWait(this.child);
      }
      throw err;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.currentClient?.close();
      this.currentClient = null;
      this.currentPort = null;
      return;
    }
    await this.killChildAndWait(child);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async killChildAndWait(child: ChildProcess): Promise<void> {
    this.stopping = true;
    this.currentClient?.close();
    this.currentClient = null;

    const waitForExit = this.exitPromise ?? Promise.resolve();

    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }

      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already exited.
          }
        }
      }, this.stopGraceMs);
      killTimer.unref();

      try {
        await waitForExit;
      } finally {
        clearTimeout(killTimer);
      }
    } else {
      await waitForExit;
    }

    if (this.child === child) {
      this.child = null;
      this.currentPort = null;
    }
    this.stopping = false;
  }

  private formatStderrSuffix(): string {
    const text = this.stderrBuffer.toString().trim();
    return text ? `: ${text}` : "";
  }
}
