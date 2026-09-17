import { spawn as spawnChild, execFileSync } from "node:child_process";
import type { Adb } from "@yume-chan/adb";
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import type {
  MaybeConsumable,
  ReadableStream as YumeReadableStream,
} from "@yume-chan/stream-extra";
import { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { createReadStream } from "node:fs";
import {
  buildDeviceLaunchPlan,
  deriveInstanceId,
  isDeviceAliveState,
  removeDeviceMarker,
  stopDeviceScope,
  touchDeviceMarker,
} from "./device-process.js";

// The devices/AVD analogue of PtyManager (pty-manager.ts) — an in-memory
// live-process map, mirroring that file's "DB row is intent, this map is
// live truth" split (AGENTS.md's own "non-obvious session model" note), but
// deliberately much simpler: no PTY, no dtach, no shell/hook-adapter launch
// plan. A Device owns one emulator process (in a transient systemd --user
// scope, see device-process.ts) plus one adb connection and — once the
// emulator is actually reachable over adb — one scrcpy session, fanning out
// video packets and forwarding input to however many WS clients are
// currently attached (BrowserPane/terminal's own "one live process, many
// viewers" shape, not "one process per viewer").
//
// Mirrors BrowserManager's `enabled: false` posture (browser-manager.ts):
// every method throws when this manager is disabled, rather than silently
// no-op-ing, so a misconfigured caller fails loudly.

export interface DeviceManagerOptions {
  enabled: boolean;
  /** Absolute path to the `adb` binary — used only for one idempotent
   * `adb start-server` call at construction; every other operation talks to
   * the running server directly over TCP. */
  adbPath: string;
  adbServerPort: number;
  emulatorPath: string;
  scrcpyServerPath: string;
  /** Same directory PtyManager's own scopes are namespaced against
   * (src/plugins/pty.ts's `ensureSessionsDir` output) — passed in rather
   * than read from app.config directly so this manager always agrees with
   * PtyManager on the actual (possibly sun_path-redirected) directory. */
  sessionsDir: string;
  /** getOrCreate() fires spawn() fire-and-forget (same shape as
   * PtyManager.getOrCreate's `void session.spawn()`) — a caller that wants
   * the outcome polls `get(id)?.toInfo().status/.error` instead of awaiting
   * anything here. This callback is ONLY so that rejection has somewhere to
   * go besides an unhandled promise rejection; `Device.spawn()` already
   * records the failure in its own `status`/`error` fields, so this is a
   * log line, not the source of truth. */
  onSpawnError?: (id: string, err: Error) => void;
}

export interface DeviceSpawnOptions {
  id: string;
  avdName: string;
  label: string | null;
}

export type DeviceLiveStatus = "starting" | "booting" | "streaming" | "exited" | "error";

export interface DeviceInfo {
  id: string;
  avdName: string;
  label: string | null;
  status: DeviceLiveStatus;
  serial: string | null;
  error: string | null;
}

const BOOT_POLL_INTERVAL_MS = 1_000;
const BOOT_TIMEOUT_MS = 120_000;

// adb's own even-port convention for emulator serials (`emulator-<port>`,
// port 5554 + 2*N) — see AOSP's `console_auth_token`/emulator docs. Bounded
// to a modest range: this manager expects "usually one AVD, occasionally a
// second," not a device farm — see buildDeviceLaunchPlan's own comment.
const EMULATOR_PORT_BASE = 5554;
const EMULATOR_PORT_MAX = 5682;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // unref() — the boot-wait poll loop below can run for up to
    // BOOT_TIMEOUT_MS; this timer alone must never keep the process (or, in
    // a test, a vitest worker) alive past everything else finishing, same
    // posture as armKillEscalation's timers (session-process.ts).
    setTimeout(resolve, ms).unref();
  });
}

export class Device {
  readonly id: string;
  readonly avdName: string;
  readonly label: string | null;

  private status: DeviceLiveStatus = "starting";
  private serial: string | null = null;
  private lastError: string | null = null;
  private adb: Adb | null = null;
  private scrcpyClient: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>> | null = null;
  private videoListeners = new Set<(packet: ScrcpyMediaStreamPacket) => void>();
  private exitListeners = new Set<() => void>();

  constructor(
    opts: DeviceSpawnOptions,
    private readonly manager: DeviceManagerOptions,
    private readonly serverClient: AdbServerClient,
    private readonly releasePort: (port: number) => void,
  ) {
    this.id = opts.id;
    this.avdName = opts.avdName;
    this.label = opts.label;
  }

  toInfo(): DeviceInfo {
    return {
      id: this.id,
      avdName: this.avdName,
      label: this.label,
      status: this.status,
      serial: this.serial,
      error: this.lastError,
    };
  }

  get isAlive(): boolean {
    return this.status !== "exited" && this.status !== "error";
  }

  get controller(): ScrcpyControlMessageWriter | undefined {
    return this.scrcpyClient?.controller;
  }

  /** The live adb connection — used by routes/devices.ts's one-shot action
   * endpoint (screenshot/tap/swipe/text/key/logcat via plain `adb shell`
   * commands) independently of whether the scrcpy video stream is
   * currently attached to any panel. Deliberately a SEPARATE path from
   * `controller` above: the live WS panel drives input through the scrcpy
   * control channel for low latency while streaming, but a one-shot CLI/MCP
   * action shouldn't require an active viewer at all. */
  get adbConnection(): Adb | undefined {
    return this.adb ?? undefined;
  }

  /** Starts the emulator's systemd scope, waits for adb to see it, then
   * pushes and starts the scrcpy server. Resolves once video is streaming;
   * rejects (leaving `status: "error"`) on any failure along the way — the
   * caller (DeviceManager.getOrCreate) is responsible for surfacing that to
   * whoever asked for this device, same as PtyManager.getOrCreate's
   * fire-and-forget `void session.spawn()` plus `spawnOutcome()` split. */
  async spawn(port: number): Promise<void> {
    try {
      this.status = "starting";
      touchDeviceMarker(this.manager.sessionsDir, this.id);
      const plan = buildDeviceLaunchPlan({
        id: this.id,
        sessionsDir: this.manager.sessionsDir,
        emulatorPath: this.manager.emulatorPath,
        avdName: this.avdName,
        extraArgs: [
          "-port",
          String(port),
          "-no-window",
          "-no-audio",
          "-gpu",
          "swiftshader_indirect",
        ],
      });

      await new Promise<void>((resolve, reject) => {
        const child = spawnChild("systemd-run", plan.argv, { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else
            reject(new Error(`device bootstrap exited with code ${code} (unit ${plan.unitName})`));
        });
      });

      this.status = "booting";
      this.serial = `emulator-${port}`;
      await this.waitForAdbSerial(this.serial);

      this.adb = await this.serverClient.createAdb({ serial: this.serial });

      // Node's own web-streams ReadableStream and @yume-chan/stream-extra's
      // (a structurally-identical, DOM-independent redeclaration — see that
      // package's own types.d.ts) are not nominally the same type, hence
      // the cast; MaybeConsumable<Uint8Array> accepts a plain Uint8Array
      // directly (MaybeConsumable<T> = T | Consumable<T>), so no chunk
      // wrapping is needed.
      const scrcpyServerStream = NodeWebReadableStream.from(
        createReadStream(this.manager.scrcpyServerPath),
      ) as unknown as YumeReadableStream<MaybeConsumable<Uint8Array>>;
      await AdbScrcpyClient.pushServer(this.adb, scrcpyServerStream);

      const options = new AdbScrcpyOptionsLatest({ video: true, audio: false, control: true });
      this.scrcpyClient = await AdbScrcpyClient.start(
        this.adb,
        "/data/local/tmp/scrcpy-server.jar",
        options,
      );

      void this.scrcpyClient.exited.then(() => this.handleExit());
      void this.pumpVideo();

      this.status = "streaming";
    } catch (err) {
      this.status = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async waitForAdbSerial(serial: string): Promise<void> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      const devices = await this.serverClient.getDevices();
      if (devices.some((d) => d.serial === serial)) return;
      if (Date.now() > deadline) {
        throw new Error(`emulator ${serial} did not appear on adb within ${BOOT_TIMEOUT_MS}ms`);
      }
      await sleep(BOOT_POLL_INTERVAL_MS);
    }
  }

  private async pumpVideo(): Promise<void> {
    if (!this.scrcpyClient) return;
    const videoStream = await this.scrcpyClient.videoStream;
    if (!videoStream) return;
    const reader = videoStream.stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const listener of this.videoListeners) listener(value);
      }
    } catch {
      // Stream errors surface via `exited` above — nothing further to do
      // here beyond letting the fan-out loop end.
    } finally {
      reader.releaseLock();
    }
  }

  private handleExit(): void {
    this.status = "exited";
    for (const listener of this.exitListeners) listener();
  }

  /** Subscribes to video packets; returns an unsubscribe function — same
   * shape as pty-manager.ts's Session.onData. */
  onVideoPacket(listener: (packet: ScrcpyMediaStreamPacket) => void): () => void {
    this.videoListeners.add(listener);
    return () => this.videoListeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Tears down the scrcpy/adb connection and stops the emulator's systemd
   * scope. Does NOT remove the device row — mirrors PtyManager.kill() vs
   * terminate()'s split; the DeviceManager caller decides which it wants. */
  async kill(): Promise<void> {
    try {
      await this.scrcpyClient?.close();
    } catch {
      // Best-effort — the process is going away regardless.
    }
    try {
      await this.adb?.close();
    } catch {
      // Same best-effort posture.
    }
    await stopDeviceScope(
      this.manager.sessionsDir,
      deriveInstanceId(this.manager.sessionsDir),
      this.id,
    );
    removeDeviceMarker(this.manager.sessionsDir, this.id);
    if (this.serial) {
      const port = Number(this.serial.replace("emulator-", ""));
      if (Number.isFinite(port)) this.releasePort(port);
    }
    this.status = "exited";
  }
}

export class DeviceManager {
  private devices = new Map<string, Device>();
  private serverClient: AdbServerClient;
  private allocatedPorts = new Set<number>();

  constructor(private readonly opts: DeviceManagerOptions) {
    this.serverClient = new AdbServerClient(
      new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: opts.adbServerPort }),
    );
    if (opts.enabled) {
      // Idempotent — a no-op if a server is already listening. Best-effort:
      // a failure here surfaces later, on the first real operation against
      // `this.serverClient`, rather than blocking construction.
      try {
        execFileSync(opts.adbPath, ["start-server"], { stdio: "ignore" });
      } catch {
        // Surfaced on first real use instead — see comment above.
      }
    }
  }

  private assertEnabled(): void {
    if (!this.opts.enabled) {
      throw new Error("device panel is disabled (set DEVICE_ENABLED=true)");
    }
  }

  private allocatePort(): number {
    for (let port = EMULATOR_PORT_BASE; port <= EMULATOR_PORT_MAX; port += 2) {
      if (!this.allocatedPorts.has(port)) {
        this.allocatedPorts.add(port);
        return port;
      }
    }
    throw new Error("no free emulator port in range");
  }

  private releasePort(port: number): void {
    this.allocatedPorts.delete(port);
  }

  get(id: string): Device | undefined {
    return this.devices.get(id);
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map((d) => d.toInfo());
  }

  /** Synchronous + idempotent, same shape as PtyManager.getOrCreate: creates
   * only if absent, fires off `spawn()` without awaiting it — callers that
   * need to know the outcome use `get(id)?.toInfo().status`/`.error` to
   * poll, or wait on the device WS route's own connect (which naturally
   * blocks until streaming or error). */
  getOrCreate(opts: DeviceSpawnOptions): Device {
    this.assertEnabled();
    const existing = this.devices.get(opts.id);
    if (existing && existing.isAlive) return existing;
    const port = this.allocatePort();
    const device = new Device(opts, this.opts, this.serverClient, this.releasePort.bind(this));
    this.devices.set(opts.id, device);
    // Device.spawn() rejects on failure (its own doc comment) — caught here
    // so the fire-and-forget call above doesn't produce an unhandled
    // promise rejection. See DeviceManagerOptions.onSpawnError's own
    // comment on why this isn't the source of truth for the failure.
    device.spawn(port).catch((err) => {
      this.opts.onSpawnError?.(opts.id, err instanceof Error ? err : new Error(String(err)));
    });
    return device;
  }

  /** Tears down the live device without removing it from the map — mirrors
   * PtyManager.kill(). */
  async kill(id: string): Promise<void> {
    const device = this.devices.get(id);
    if (!device) return;
    await device.kill();
  }

  /** kill() plus dropping this manager's own reference — the in-memory-map
   * half of PtyManager.terminate(); the DB row deletion is the route's own
   * job, same split routes/sessions.ts's killSession keeps today. */
  async terminate(id: string): Promise<void> {
    await this.kill(id);
    this.devices.delete(id);
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.devices.keys()].map((id) => this.kill(id)));
  }

  /** Reconciliation liveness check for a device whose scope may have
   * survived a Mullion restart with no in-memory Device to represent it —
   * same role session-reconciler.ts's sweep plays for sessions. Devices
   * don't currently auto-reattach across a restart (unlike a session's
   * dtach master, an emulator's scrcpy connection can't be "reattached" —
   * only the scope's liveness can be confirmed); a restart-surviving
   * emulator is visible here as "alive" but requires a fresh
   * getOrCreate()-driven scrcpy (re)connect to actually stream again. */
  async isScopeAlive(id: string): Promise<boolean> {
    const state = await isDeviceAliveState(
      this.opts.sessionsDir,
      deriveInstanceId(this.opts.sessionsDir),
      id,
    );
    return state === "alive";
  }
}
