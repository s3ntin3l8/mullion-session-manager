import { spawn as spawnChild } from "node:child_process";
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
  /** Fired synchronously from the very start of Device.spawn(), before
   * `systemd-run` is even invoked — NOT after boot succeeds — so that a
   * Mullion restart at ANY point afterward (including mid-boot, which can
   * take up to BOOT_TIMEOUT_MS) leaves a durable, accurate record of the
   * port the surviving scope is actually bound to. DeviceManager
   * deliberately never touches `app.db` itself (routes own the DB row; this
   * manager owns process lifecycle only — see this interface's own header),
   * so persisting the port is the CALLER's job; this callback is the only
   * hook back across that line, mirroring onSpawnError's own shape.
   * src/plugins/device.ts wires this to an `app.db.update(devices)
   * .set({ port })...` call rather than each route doing it individually,
   * since the manager (and this callback) are constructed once, there. */
  onPortAssigned?: (id: string, port: number) => void;
}

export interface DeviceSpawnOptions {
  id: string;
  avdName: string;
  label: string | null;
  /** The persisted `devices.port` DB column (null until a device has
   * spawned at least once). getOrCreate() reads this ONLY on the reattach
   * path (isScopeAlive() true, no in-memory Device) to reconstruct the
   * `emulator-<port>` serial of a scope that survived a Mullion restart —
   * see that method's own comment. Ignored otherwise: a normal spawn()
   * always allocates a FRESH port via DeviceManager.allocatePort(); it has
   * no existing emulator to match a serial against, so reusing a stale
   * persisted value here would be wrong. */
  port: number | null;
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
  /** Set at the start of spawn(), read (and released) by teardownProcess() —
   * whichever teardown path fires (an in-flight spawn() failing partway
   * through, kill(), or handleExit() after an unexpected scrcpy exit) needs
   * to release the SAME port, including a failure before `this.serial` was
   * ever set (systemd-run itself failing, say) — deriving the port from
   * `this.serial` alone (as kill() used to) misses exactly that case. */
  private allocatedPort: number | null = null;
  /** The stream's one-time SPS/PPS packet — @yume-chan/scrcpy's own parser
   * emits this exactly once per connection, not per keyframe (see
   * pumpVideo's own comment), so a listener that subscribes after it
   * already went out (a second panel, or a reconnect after a network blip)
   * would otherwise never get it and its WebCodecs decoder would never
   * configure. Replayed synchronously to a new subscriber in
   * onVideoPacket() below. */
  private lastConfigPacket: ScrcpyMediaStreamPacket | null = null;

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
    this.allocatedPort = port;
    // Persisted immediately — see DeviceManagerOptions.onPortAssigned's own
    // comment on why this fires before `systemd-run` even runs, not after
    // boot succeeds.
    this.manager.onPortAssigned?.(this.id, port);
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
      await this.startScrcpySession(this.adb);

      this.status = "streaming";
    } catch (err) {
      this.status = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      // Whatever partially started (the systemd scope, the marker file, the
      // allocated port) must not leak on failure — an uncleaned scope
      // permanently blocks every future spawn() for this same id, since
      // deviceScopeUnitName is purely id-derived and `systemd-run --collect`
      // refuses a name that's still occupied.
      await this.teardownProcess().catch(() => {
        // Best-effort — a cleanup failure must not mask the original spawn
        // error below.
      });
      throw err;
    }
  }

  /** Reattaches to an emulator scope that survived a Mullion restart —
   * DeviceManager.getOrCreate()'s reattach path, fired the same
   * fire-and-forget way spawn() is. `port` is the persisted `devices.port`
   * DB column spawn() recorded via onPortAssigned. Skips
   * systemd-run/buildDeviceLaunchPlan/touchDeviceMarker entirely: the
   * emulator process is already running (that's the whole premise of this
   * path), so only the adb+scrcpy connection needs (re)establishing.
   * scrcpy itself is stateless from the client's perspective — starting a
   * fresh scrcpy server connection against an already-running emulator is
   * normal, expected usage, not a special case scrcpy needs to support.
   *
   * Liveness (does this serial actually still show up on `adb devices`?)
   * is deliberately NOT checked here — getOrCreate() already confirmed that
   * BEFORE constructing this Device or calling attach() at all, specifically
   * so a dead-process failure is a synchronous reject from getOrCreate()
   * itself (the route's existing error handling surfaces it to the caller
   * — see routes/device.ts's attachSocketToDevice) rather than a fire-and-
   * forget failure this WS route would never observe: unlike spawn(),
   * nothing here ever produces an onExit() firing (no scrcpyClient was ever
   * created) to signal it another way.
   *
   * Deliberately NOT the same full-teardown-on-any-failure posture as
   * spawn()'s own catch: spawn() owns the scope it just created, so
   * stopping it on failure only cleans up spawn()'s own mess. attach() did
   * NOT create this scope — by the time this runs, the emulator is
   * confirmed alive; a failure here (a transient adb hiccup, `createAdb`
   * failing, scrcpy's own push/start failing) is a failure to CONNECT to
   * it, not evidence it's gone. Stopping the scope on that basis would
   * destroy the exact thing this feature exists to preserve. So this only
   * ever tears down the (partial) adb/scrcpy connection THIS attempt itself
   * opened — a later getOrCreate() call sees isScopeAlive() still true and
   * the port still persisted, and simply retries attach() against the same
   * scope. */
  async attach(port: number): Promise<void> {
    this.allocatedPort = port;
    this.serial = `emulator-${port}`;
    this.status = "booting";
    try {
      this.adb = await this.serverClient.createAdb({ serial: this.serial });
      await this.startScrcpySession(this.adb);
      this.status = "streaming";
    } catch (err) {
      this.status = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      // See this method's own comment — only what THIS attempt opened,
      // never the scope.
      await this.adb?.close().catch(() => {});
      this.adb = null;
      this.scrcpyClient = null;
      throw err;
    }
  }

  /** Pushes and starts the scrcpy server against the already-established
   * `this.adb` connection, and wires up the exit/video-pump plumbing both
   * spawn() (a fresh emulator) and attach() (a restart-surviving one) need
   * identically once they reach this point. */
  private async startScrcpySession(adb: Adb): Promise<void> {
    // Node's own web-streams ReadableStream and @yume-chan/stream-extra's
    // (a structurally-identical, DOM-independent redeclaration — see that
    // package's own types.d.ts) are not nominally the same type, hence
    // the cast; MaybeConsumable<Uint8Array> accepts a plain Uint8Array
    // directly (MaybeConsumable<T> = T | Consumable<T>), so no chunk
    // wrapping is needed.
    const scrcpyServerStream = NodeWebReadableStream.from(
      createReadStream(this.manager.scrcpyServerPath),
    ) as unknown as YumeReadableStream<MaybeConsumable<Uint8Array>>;
    await AdbScrcpyClient.pushServer(adb, scrcpyServerStream);

    const options = new AdbScrcpyOptionsLatest({ video: true, audio: false, control: true });
    this.scrcpyClient = await AdbScrcpyClient.start(
      adb,
      "/data/local/tmp/scrcpy-server.jar",
      options,
    );

    void this.scrcpyClient.exited.then(() => this.handleExit());
    void this.pumpVideo();
  }

  /** Stops the scope, removes the marker, closes the scrcpy/adb connections,
   * and releases the allocated port — the one teardown path every exit
   * route (a failed spawn(), kill(), or handleExit() after an unexpected
   * scrcpy exit) funnels through, so none of them can leak a subset of what
   * the others clean up. Idempotent: safe to call on a Device that never
   * got past `touchDeviceMarker`/port allocation. */
  private async teardownProcess(): Promise<void> {
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
    if (this.allocatedPort !== null) {
      this.releasePort(this.allocatedPort);
      this.allocatedPort = null;
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
        // Cached so a listener that subscribes AFTER this went out (a
        // second panel, or a reconnect) still gets it — see this field's
        // own doc comment.
        if (value.type === "configuration") this.lastConfigPacket = value;
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
    // Best-effort — an unexpected scrcpy exit (the emulator crashed, adb
    // dropped the connection) must still release the scope/marker/port the
    // same way a deliberate kill() does, or this device id is stuck the
    // same way a failed spawn() used to be (see teardownProcess's own
    // comment).
    void this.teardownProcess().catch(() => {});
  }

  /** Subscribes to video packets; returns an unsubscribe function — same
   * shape as pty-manager.ts's Session.onData. Replays the cached
   * configuration packet (if any) synchronously to a NEW subscriber before
   * returning, so a decoder that attaches after streaming already started
   * still gets the SPS/PPS it needs to configure at all — see
   * lastConfigPacket's own doc comment. */
  onVideoPacket(listener: (packet: ScrcpyMediaStreamPacket) => void): () => void {
    this.videoListeners.add(listener);
    if (this.lastConfigPacket) listener(this.lastConfigPacket);
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
    await this.teardownProcess();
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
      // Idempotent — a no-op if a server is already listening. Best-effort,
      // fire-and-forget: a failure here surfaces later, on the first real
      // operation against `this.serverClient`, rather than blocking
      // construction. Deliberately async (spawn, not execFileSync) — this
      // constructor runs during `app.register(devicePlugin)` at server
      // boot, and a synchronous exec here would block the ENTIRE event
      // loop (every other plugin registration, WS accept, and request)
      // for however long `adb start-server` takes.
      const child = spawnChild(opts.adbPath, ["start-server"], { stdio: "ignore" });
      child.on("error", () => {});
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

  /** Marks a port in-use WITHOUT taking it from the round-robin scan —
   * used only by getOrCreate()'s reattach path, where the port comes from a
   * persisted DB column (a scope that survived a restart) rather than a
   * fresh allocatePort() call. Without this, a concurrent normal spawn()
   * could hand this same port to an unrelated new device while the
   * reattached one is still using it. */
  private reservePort(port: number): void {
    this.allocatedPorts.add(port);
  }

  get(id: string): Device | undefined {
    return this.devices.get(id);
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map((d) => d.toInfo());
  }

  /** Idempotent, same shape as PtyManager.getOrCreate: creates only if
   * absent, fires off `spawn()`/`attach()` without awaiting it — callers
   * that need to know the outcome use `get(id)?.toInfo().status`/`.error`
   * to poll, or wait on the device WS route's own connect (which naturally
   * blocks until streaming or error). Async (unlike PtyManager's
   * synchronous version) ONLY for the isScopeAlive() pre-check below — both
   * current callers already run inside an async route handler.
   *
   * That pre-check exists because a scope for this id may have survived a
   * Mullion restart with no in-memory Device left to represent it. Spawning
   * anyway would collide with it (`systemd-run --collect -u <name>` refuses
   * a name that's still occupied) and fail with a cryptic exit code,
   * permanently wedging this device id until an operator manually stops the
   * leftover scope. When `opts.port` has a persisted value to reattach
   * with, this reattaches (`Device.attach()`) instead of spawning fresh —
   * see that method's own comment. When it doesn't (a row from before the
   * `port` column existed, or one whose Device never got past
   * touchDeviceMarker before a spawn() failure recorded no port), there is
   * nothing to reconstruct a serial from, so this still falls back to the
   * original clear-and-actionable error naming the manual `systemctl --user
   * stop` command. */
  async getOrCreate(opts: DeviceSpawnOptions): Promise<Device> {
    this.assertEnabled();
    const existing = this.devices.get(opts.id);
    if (existing && existing.isAlive) return existing;

    if (await this.isScopeAlive(opts.id)) {
      if (opts.port === null) {
        const instanceId = deriveInstanceId(this.opts.sessionsDir);
        throw new Error(
          `device ${opts.id} has a systemd scope left running from before a restart, with no ` +
            `persisted port to reattach with — stop it manually: systemctl --user stop ` +
            `crs-device-${instanceId}-${opts.id}.scope`,
        );
      }
      const port = opts.port;
      const serial = `emulator-${port}`;
      // Awaited (unlike attach()'s own connection work below, which is
      // fire-and-forget) so a CONFIRMED-gone emulator process rejects
      // getOrCreate() itself, synchronously, the same clear way the
      // no-persisted-port case above does — both current callers already
      // surface a getOrCreate() rejection to whoever's waiting (routes/
      // device.ts's attachSocketToDevice sends it down the WS before ever
      // subscribing to anything; routes/devices.ts's POST handler
      // badRequests with it). A fire-and-forget failure here would instead
      // leave a WS socket open with no video and no error — attach()
      // itself never produces an onExit() firing for this case (no
      // scrcpyClient is ever created), so nothing would ever tell the
      // client. If this call itself REJECTS (adb server unreachable, say)
      // that propagates too, WITHOUT stopping the scope — "unknown" must
      // never collapse to "dead" for a caller about to take a destructive
      // action, the same trust rule device-process.ts's own
      // DeviceScopeOwnershipListing documents.
      const liveDevices = await this.serverClient.getDevices();
      if (!liveDevices.some((d) => d.serial === serial)) {
        // Confirmed gone, not just unreachable — safe, and necessary (so a
        // future spawn() for this id isn't wedged by the still-occupied
        // unit name), to fully tear down: nothing here is actually still
        // running. Nothing was ever reserved/constructed for this attempt,
        // so there's nothing else to release.
        const instanceId = deriveInstanceId(this.opts.sessionsDir);
        await stopDeviceScope(this.opts.sessionsDir, instanceId, opts.id).catch(() => {});
        removeDeviceMarker(this.opts.sessionsDir, opts.id);
        throw new Error(
          `device ${opts.id}'s emulator (${serial}) is no longer reachable over adb — the ` +
            `emulator process itself must have exited, not just Mullion`,
        );
      }

      const device = new Device(opts, this.opts, this.serverClient, this.releasePort.bind(this));
      this.devices.set(opts.id, device);
      this.reservePort(port);
      // Device.attach() rejects on failure (its own doc comment) — caught
      // here for the same reason spawn()'s own fire-and-forget call below
      // is: see DeviceManagerOptions.onSpawnError's own comment. Unlike the
      // liveness check just above, a failure past this point is a
      // connection failure against a CONFIRMED-alive emulator (see
      // attach()'s own comment on why that stays fire-and-forget rather
      // than blocking getOrCreate() on the full adb+scrcpy handshake).
      device.attach(port).catch((err) => {
        this.opts.onSpawnError?.(opts.id, err instanceof Error ? err : new Error(String(err)));
      });
      return device;
    }

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
   * same role session-reconciler.ts's sweep plays for sessions. Unlike a
   * session's dtach master, an emulator's scrcpy connection itself can't be
   * "reattached" (scrcpy is stateless from the client's perspective) —
   * only the scope's liveness can be confirmed here. getOrCreate() is what
   * turns "alive" into an actual resumed stream, via Device.attach(). */
  async isScopeAlive(id: string): Promise<boolean> {
    const state = await isDeviceAliveState(
      this.opts.sessionsDir,
      deriveInstanceId(this.opts.sessionsDir),
      id,
    );
    return state === "alive";
  }
}
