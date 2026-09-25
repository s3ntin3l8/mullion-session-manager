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
import {
  DEFAULT_DEVICE_EMULATOR_GPU,
  DEFAULT_DEVICE_VIDEO_BIT_RATE,
  DEFAULT_DEVICE_VIDEO_MAX_FPS,
  DEFAULT_DEVICE_VIDEO_MAX_SIZE,
} from "./device-defaults.js";

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
  /** scrcpy stream tuning — see env.ts's DEVICE_VIDEO_* comments. Optional
   * so a caller that doesn't care (tests) gets the same defaults as the env
   * schema. `0` means native size / uncapped fps. */
  videoMaxSize?: number;
  videoMaxFps?: number;
  videoBitRate?: number;
  /** Emulator `-gpu` mode — see env.ts's DEVICE_EMULATOR_GPU comment. */
  emulatorGpu?: string;
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
  /** Ports already in use by every persisted `status: "active"` device row,
   * read synchronously by src/plugins/device.ts (better-sqlite3, no async
   * gap) BEFORE constructing this manager. `allocatedPorts` otherwise starts
   * empty on every boot and only gains an entry via allocatePort() (a fresh
   * spawn()) or reservePort() (getOrCreate()'s reattach branch) — the latter
   * only once something actually calls getOrCreate() for that device id. A
   * restart-surviving device nobody has touched yet since boot would
   * otherwise be invisible to allocatePort()'s round-robin scan, letting a
   * concurrent brand-new device's spawn() claim its still-bound port. Absent
   * (empty) on the multi-host "agent" role, where app.db doesn't exist — see
   * this field's caller in device.ts.
   *
   * Nothing here ever calls reservePort() for a device seeded this way, so
   * getOrCreate() itself is responsible for releasing a seeded port again
   * once it can positively confirm that device's own scope/process is gone
   * — see its own two releasePort() call sites (the no-scope-survived
   * fallthrough and the scope-alive-but-adb-can't-see-it branch). Skipping
   * that release would strand the port for the rest of this process's
   * lifetime the first time a device seeded here turns out to have actually
   * died independently of Mullion (a host reboot, a crash) while its row
   * stayed `status: "active"`. */
  initialPorts?: number[];
}

export type DeviceKind = "emulator" | "physical";

export interface DeviceSpawnOptions {
  id: string;
  kind: DeviceKind;
  /** The AVD name passed to `emulator -avd <avdName>`. Set only for
   * `kind: "emulator"` — null (and ignored) for `kind: "physical"`. */
  avdName: string | null;
  /** The persisted `devices.serial` DB column — a physical device's adb TCP
   * address (`host:port`), used both as the address `wireless.connect()`
   * dials and, once connected, directly as the device's adb serial (a
   * physical device over wireless debugging has no separate synthesized
   * serial the way an emulator's `emulator-<port>` is). Set only for
   * `kind: "physical"` — null (and ignored) for `kind: "emulator"`. */
  serial: string | null;
  label: string | null;
  /** The persisted `devices.port` DB column (null until a device has
   * spawned at least once). getOrCreate() reads this ONLY on the reattach
   * path (isScopeAlive() true, no in-memory Device) to reconstruct the
   * `emulator-<port>` serial of a scope that survived a Mullion restart —
   * see that method's own comment. Ignored otherwise: a normal spawn()
   * always allocates a FRESH port via DeviceManager.allocatePort(); it has
   * no existing emulator to match a serial against, so reusing a stale
   * persisted value here would be wrong. Always null for `kind: "physical"`
   * — a physical device has no emulator port pool slot to reserve. */
  port: number | null;
}

export type DeviceLiveStatus = "starting" | "booting" | "streaming" | "exited" | "error";

export interface DeviceInfo {
  id: string;
  kind: DeviceKind;
  avdName: string | null;
  label: string | null;
  status: DeviceLiveStatus;
  serial: string | null;
  error: string | null;
}

const BOOT_POLL_INTERVAL_MS = 1_000;
const BOOT_TIMEOUT_MS = 120_000;
// A physical device is either reachable within a few seconds or not at all
// (no cold-boot analogue to wait out) — BOOT_TIMEOUT_MS's two minutes is
// tuned for an emulator's actual boot time and would make a wrong/stale
// wireless-debugging address hang the UI for far longer than useful.
const PHYSICAL_CONNECT_TIMEOUT_MS = 15_000;

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
  readonly kind: DeviceKind;
  readonly avdName: string | null;
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
   * onVideoPacket() below. Config alone isn't enough to start decoding —
   * routes/device.ts additionally gates each socket on a keyframe and
   * requests one on attach. */
  private lastConfigPacket: ScrcpyMediaStreamPacket | null = null;

  constructor(
    opts: DeviceSpawnOptions,
    private readonly manager: DeviceManagerOptions,
    private readonly serverClient: AdbServerClient,
    private readonly releasePort: (port: number) => void,
  ) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.avdName = opts.avdName;
    this.label = opts.label;
  }

  toInfo(): DeviceInfo {
    return {
      id: this.id,
      kind: this.kind,
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
    // Emulator-only — connectPhysical() is the physical-device equivalent
    // entry point and never calls this. Guarded at runtime (not just by the
    // DeviceManager.getOrCreate() branch that decides which to call) so a
    // caller mistake fails loudly here rather than passing `null` into
    // buildDeviceLaunchPlan as a bare string.
    if (this.avdName === null) {
      throw new Error(`device ${this.id} has kind "${this.kind}" — spawn() is emulator-only`);
    }
    const avdName = this.avdName;
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
        avdName,
        extraArgs: [
          "-port",
          String(port),
          "-no-window",
          "-no-audio",
          "-gpu",
          this.manager.emulatorGpu ?? DEFAULT_DEVICE_EMULATOR_GPU,
        ],
      });

      // Populated by the post-settle exit handler if the scope exits non-zero
      // *after* setImmediate has already resolved the bootstrap promise (the
      // production failure window: D-Bus error, unit collision, immediate
      // emulator crash). Raced against the adb poll below so the specific error
      // surfaces at once instead of waiting for the 120s adb timeout.
      let bootstrapFailReject: ((err: Error) => void) | null = null;
      const bootstrapFailed = new Promise<never>((_resolve, reject) => {
        bootstrapFailReject = reject;
      });
      // Prevent Node from treating the above as an unhandled rejection during
      // the window between creation and the Promise.race() that consumes it.
      bootstrapFailed.catch(() => {});

      // Durable copy of the same failure, shared by THREE readers that the
      // one-shot rejection above can't serve on its own:
      //   1. the exit/error handlers below — once spawn() has reached
      //      streaming (`spawnFinished`), a later exit is a normal lifetime
      //      event and must not be recorded as a boot failure;
      //   2. waitForAdbSerial's poll loop — the loser of the race above keeps
      //      running, so once bootstrapFailed has won the loop must stop
      //      burning a getDevices() call every BOOT_POLL_INTERVAL_MS for the
      //      rest of BOOT_TIMEOUT_MS;
      //   3. spawn() itself after the race — if the scope dies while createAdb
      //      / startScrcpySession is still awaited, bootstrapFailed's
      //      rejection is too late to observe, so spawn() re-checks this and
      //      aborts with the specific error rather than reaching
      //      `status = "streaming"` on an emulator that is already gone.
      const scopeExit: { error: Error | null } = { error: null };
      /** Set true only on spawn()'s own success path, synchronously with
       * `status = "streaming"`. Once streaming, a later scope exit is a
       * normal lifetime event (handleExit only) — recording it would reject
       * a bootstrap promise spawn() has already consumed. */
      let spawnFinished = false;
      const recordScopeExit = (error: Error): void => {
        if (spawnFinished) return;
        scopeExit.error = error;
        bootstrapFailReject?.(error);
      };

      await new Promise<void>((resolve, reject) => {
        const child = spawnChild("systemd-run", plan.argv, { stdio: "ignore" });
        let settled = false;

        child.on("error", (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          } else {
            // Same defect class as the exit branch below: a post-settle error
            // means the scope is gone while spawn() may still be waiting on
            // adb — record it so the boot path aborts instead of timing out.
            recordScopeExit(err instanceof Error ? err : new Error(String(err)));
            this.handleExit();
          }
        });

        child.on("exit", (code) => {
          if (!settled) {
            if (code !== 0) {
              settled = true;
              reject(
                new Error(`device bootstrap exited with code ${code} (unit ${plan.unitName})`),
              );
              return;
            }
            // An exit code 0 during the bootstrap window (e.g. from test mocks)
            // indicates successful scope launch.
            settled = true;
            resolve();
          } else {
            // Already past the bootstrap promise. If the scope dies during the
            // boot window (before streaming), surface it immediately via
            // bootstrapFailed rather than waiting for the full adb timeout —
            // and, once the race below has already settled, via scopeExit so
            // spawn()'s own post-race checks catch it (see scopeExit's comment).
            // Exit code 0 (graceful emulator shutdown mid-boot) also counts as
            // a scope failure; once streaming it becomes a normal handleExit().
            recordScopeExit(
              new Error(
                `device scope exited during boot with code ${code ?? "null"} (unit ${plan.unitName})`,
              ),
            );
            this.handleExit();
          }
        });

        // In production, `systemd-run --scope` runs the emulator in the foreground
        // and stays alive for the emulator's full lifespan. Once spawned without an
        // immediate error or non-zero exit, proceed to boot monitoring while the
        // exit listener remains attached for process lifecycle tracking.
        setImmediate(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });

      this.status = "booting";
      this.serial = `emulator-${port}`;
      // Race the adb poll against the scope's own exit signal: if systemd-run
      // exits during boot (D-Bus error, unit collision, immediate emulator
      // crash), the specific "scope exited during boot" error surfaces at once
      // rather than waiting for the full BOOT_TIMEOUT_MS generic timeout. The
      // poll loop is passed scopeExit so that when THIS side of the race wins,
      // the adb poll stops too instead of running out its 120s deadline in the
      // background.
      await Promise.race([
        this.waitForAdbSerial(this.serial, BOOT_TIMEOUT_MS, scopeExit),
        bootstrapFailed,
      ]);

      // The race can settle via adb while the scope dies during either await
      // below — bootstrapFailed's rejection is then unobservable (the race is
      // already decided). Re-check the recorded failure so the specific scope
      // message wins over whatever createAdb/scrcpy would report, and so
      // `status = "streaming"` at the end of this method can never be reached
      // on a scope that has already gone through handleExit() (whose
      // "exited" + teardown this would otherwise silently overwrite).
      this.adb = await this.serverClient.createAdb({ serial: this.serial });
      if (scopeExit.error) throw scopeExit.error;
      await this.startScrcpySession(this.adb);
      if (scopeExit.error) throw scopeExit.error;

      spawnFinished = true;
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

  /** Connects to a physical device over adb wireless debugging at the given
   * adb TCP address, then starts a scrcpy session — the `kind: "physical"`
   * analogue of attach() (a restart-surviving emulator): startScrcpySession()
   * below is serial-agnostic, so the two differ only in HOW the connection
   * is established. No scope, no marker, no port allocation: Mullion never
   * spawns a physical device the way it spawns an emulator, only connects to
   * one the user has already paired (DeviceManager.pair(), a separate call —
   * pairing has no "device" object to attach to yet, just the adb server's
   * own keystore).
   *
   * `AdbServerClient.AlreadyConnectedError` from wireless.connect() is NOT
   * treated as a failure here: it means this exact address is already in
   * the adb server's connection table (e.g. Mullion itself connected it on
   * a previous getOrCreate() and never disconnected — kill() deliberately
   * never calls wireless.disconnect(), see its own comment), so this
   * proceeds exactly as if connect() had just succeeded. Any OTHER error
   * (UnauthorizedError — the phone hasn't approved this pairing/host key;
   * NetworkError — nothing listening at that address) propagates and
   * leaves `status: "error"`, same as attach()'s own catch. */
  async connectPhysical(address: string): Promise<void> {
    this.allocatedPort = null;
    this.serial = address;
    this.status = "booting";
    try {
      try {
        await this.serverClient.wireless.connect(address);
      } catch (err) {
        if (!(err instanceof AdbServerClient.AlreadyConnectedError)) throw err;
      }
      await this.waitForAdbSerial(address, PHYSICAL_CONNECT_TIMEOUT_MS);
      this.adb = await this.serverClient.createAdb({ serial: address });
      await this.startScrcpySession(this.adb);
      this.status = "streaming";
    } catch (err) {
      this.status = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      // See attach()'s own comment — only what THIS attempt opened; there is
      // no scope to leave alone here in the first place.
      await this.adb?.close().catch(() => {});
      this.adb = null;
      this.scrcpyClient = null;
      throw err;
    }
  }

  /** Pushes and starts the scrcpy server against the already-established
   * `this.adb` connection, and wires up the exit/video-pump plumbing every
   * connection path (spawn(), attach(), connectPhysical()) needs
   * identically once it reaches this point. */
  private async startScrcpySession(adb: Adb): Promise<void> {
    // An unset DEVICE_SCRCPY_SERVER_PATH ("" = not configured) must fail as
    // an ordinary rejected spawn — `createReadStream("")` instead surfaces
    // its ENOENT as an uncaught exception outside this promise chain.
    if (!this.manager.scrcpyServerPath) {
      throw new Error("DEVICE_SCRCPY_SERVER_PATH is not configured");
    }
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

    const options = new AdbScrcpyOptionsLatest({
      video: true,
      audio: false,
      control: true,
      maxSize: this.manager.videoMaxSize ?? DEFAULT_DEVICE_VIDEO_MAX_SIZE,
      maxFps: this.manager.videoMaxFps ?? DEFAULT_DEVICE_VIDEO_MAX_FPS,
      videoBitRate: this.manager.videoBitRate ?? DEFAULT_DEVICE_VIDEO_BIT_RATE,
    });
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
   * got past `touchDeviceMarker`/port allocation.
   *
   * Skips the scope/marker/port steps entirely for `kind: "physical"` —
   * not merely an optimization: connectPhysical() never touches any of the
   * three (no `systemd-run`, no marker file, no port ever allocated for a
   * device Mullion didn't spawn), so calling stopDeviceScope()/
   * removeDeviceMarker() here would be resolving ownership for a scope that
   * was never created under this id in the first place. The adb server
   * connection itself is deliberately left alone too — see kill()'s own
   * comment on why disconnect() never happens here either. */
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
    if (this.kind === "emulator") {
      await stopDeviceScope(
        this.manager.sessionsDir,
        deriveInstanceId(this.manager.sessionsDir),
        this.id,
      );
      removeDeviceMarker(this.manager.sessionsDir, this.id);
    }
    if (this.allocatedPort !== null) {
      this.releasePort(this.allocatedPort);
      this.allocatedPort = null;
    }
  }

  /** Polls adb for `serial` until it appears or `timeoutMs` elapses.
   *
   * `scopeExit` is spawn()'s shared failure record: Promise.race does not
   * cancel its loser, so when the sibling `bootstrapFailed` wins the race the
   * loop here would otherwise keep calling getDevices() once per
   * BOOT_POLL_INTERVAL_MS until BOOT_TIMEOUT_MS (120s) expires — bounded and
   * harmless, but pure waste. Checked at the TOP of each iteration, before
   * getDevices(), so an aborted wait issues no further polls at all. Throwing
   * the recorded error (rather than a generic "aborted" one) keeps this loop's
   * own failure message as the specific scope failure should it ever be the
   * side that settles the race. Optional: connectPhysical() has no scope to
   * die, so it passes nothing. */
  private async waitForAdbSerial(
    serial: string,
    timeoutMs: number,
    scopeExit?: { error: Error | null },
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (scopeExit?.error) throw scopeExit.error;
      const devices = await this.serverClient.getDevices();
      if (devices.some((d) => d.serial === serial)) return;
      if (Date.now() > deadline) {
        throw new Error(`device ${serial} did not appear on adb within ${timeoutMs}ms`);
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

  /** Tears down the scrcpy/adb connection and — for `kind: "emulator"` only
   * — stops the emulator's systemd scope (see teardownProcess()'s own
   * comment on why a physical device skips that). Does NOT remove the
   * device row — mirrors PtyManager.kill() vs terminate()'s split; the
   * DeviceManager caller decides which it wants. */
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
    // See DeviceManagerOptions.initialPorts's own comment — reserved up
    // front, not just for devices reservePort() has been called for.
    for (const port of opts.initialPorts ?? []) {
      this.allocatedPorts.add(port);
    }
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
   * stop` command.
   *
   * `kind: "physical"` branches off BEFORE any of the above: isScopeAlive()
   * asks whether a systemd scope exists for this id, and a physical device
   * never has one (Mullion never spawns it), so it would simply come back
   * "dead" and fall through to the allocatePort()/spawn() branch at the
   * bottom — trying to boot an emulator from a null avdName. There is
   * nothing to reattach to and nothing to reconcile against a systemd
   * listing; connectPhysical() is unconditionally the right (and only)
   * thing to do for every call with this kind. */
  async getOrCreate(opts: DeviceSpawnOptions): Promise<Device> {
    this.assertEnabled();
    const existing = this.devices.get(opts.id);
    if (existing && existing.isAlive) return existing;

    if (opts.kind === "physical") {
      if (opts.serial === null) {
        throw new Error(`physical device ${opts.id} has no persisted adb address to connect to`);
      }
      const serial = opts.serial;
      // If `existing` above was present but !isAlive, this REPLACES it —
      // safe only because a non-alive Device has already released whatever
      // it held: an `error` one nulled its adb/scrcpy in connectPhysical()'s
      // own catch, an `exited` one went through kill()'s teardownProcess().
      // No separate "allow reconnect" re-entry path here the way the
      // emulator branch below has for a restart-surviving scope — nothing
      // to reconnect an old physical Device instance TO.
      const device = new Device(opts, this.opts, this.serverClient, this.releasePort.bind(this));
      this.devices.set(opts.id, device);
      // Fire-and-forget, same shape as spawn()/attach() below — a caller
      // polls get(id)?.toInfo().status/.error, or waits on the device WS
      // route's own connect.
      device.connectPhysical(serial).catch((err) => {
        this.opts.onSpawnError?.(opts.id, err instanceof Error ? err : new Error(String(err)));
      });
      return device;
    }

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
        // `port` may be reserved with nothing ever having called
        // reservePort() for THIS attempt — DeviceManagerOptions.initialPorts
        // pre-seeds it at construction from every persisted `active` row,
        // this device's included. Now confirmed gone, so it's genuinely
        // free; leaving it reserved would strand a pool slot for the rest of
        // this process's lifetime (releasePort() is a no-op if it was never
        // actually reserved).
        this.releasePort(port);
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

    // isScopeAlive() above just confirmed NO scope survives for this id at
    // all — if opts.port is set, it's a persisted value from a device whose
    // scope died independently of Mullion (a host reboot, a crash) while its
    // DB row stayed `status: "active"`. initialPorts (see that field's own
    // comment) pre-seeded it into allocatedPorts at construction with
    // nothing else ever tied to release it; freeing it here, before
    // allocating fresh, keeps it from permanently stranding a pool slot for
    // the rest of this process's lifetime. No-op if it was never actually
    // reserved.
    if (opts.port !== null) {
      this.releasePort(opts.port);
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
   * PtyManager.kill(). Hermes review: the in-memory map being empty is NOT
   * the same as "nothing to stop" — a scope that survived a Mullion
   * restart has no in-memory `Device` to represent it (same case
   * `isScopeAlive()`/`getOrCreate()`'s pre-check exists for), and this
   * method used to silently no-op for exactly that id, leaving the row
   * flipped to "killed" while the real emulator (a KVM handle + several
   * GB) kept running with no API path left to ever stop it again — the
   * `getOrCreate()` collision-guard would throw on it forever. Falls back
   * to stopping by DERIVED unit name/marker directly (the same thing
   * `stopDeviceScope` already does when it can't confirm ownership any
   * other way — see its own doc comment), rather than requiring a live
   * `Device` instance to call `.kill()` through.
   *
   * `kind` is only consulted on THAT fallback path — a live in-memory
   * `Device` already knows its own kind (see teardownProcess()'s own
   * check) and this trusts it over whatever the caller passed. For
   * `kind: "physical"` with no in-memory Device, there is nothing to stop:
   * a physical device never gets a systemd scope in the first place (see
   * connectPhysical()'s own comment), so falling through to
   * stopDeviceScope()/removeDeviceMarker() would be resolving ownership
   * for a scope that could never have existed under this id. This also
   * deliberately never calls `wireless.disconnect()` — the adb server's
   * connection table is host-global state shared with the user's own adb
   * tooling outside this session, not Mullion's to tear down; a killed
   * physical row simply stops being tracked here while the phone stays
   * connected to the host's adb server (re-adding it later hits the
   * AlreadyConnectedError path connectPhysical() already treats as
   * success). */
  async kill(id: string, kind: DeviceKind): Promise<void> {
    const device = this.devices.get(id);
    if (device) {
      await device.kill();
      return;
    }
    if (kind === "physical") return;
    await stopDeviceScope(this.opts.sessionsDir, deriveInstanceId(this.opts.sessionsDir), id);
    removeDeviceMarker(this.opts.sessionsDir, id);
  }

  /** kill() plus dropping this manager's own reference — the in-memory-map
   * half of PtyManager.terminate(); the DB row deletion is the route's own
   * job, same split routes/sessions.ts's killSession keeps today. */
  async terminate(id: string, kind: DeviceKind): Promise<void> {
    await this.kill(id, kind);
    this.devices.delete(id);
  }

  async killAll(): Promise<void> {
    // Every id here already has a live in-memory Device (this.devices'
    // own keys), so kill()'s `kind` argument only matters on its
    // no-in-memory-Device fallback path and is never actually consulted
    // here — passed through anyway (rather than a placeholder) so this
    // reads correctly on its own, without relying on that fact.
    await Promise.all(
      [...this.devices.entries()].map(([id, device]) => this.kill(id, device.kind)),
    );
  }

  /** Pairs with a device over adb wireless debugging (Android 11+'s
   * `adb pair <host:port> <code>`) — the one-time step that authorizes the
   * host's adb server to connect to this phone at all, ahead of an actual
   * `connect()` (which getOrCreate()'s `kind: "physical"` branch performs,
   * via connectPhysical()). Deliberately NOT tied to any `devices` row —
   * pairing writes a key into the adb SERVER's own keystore, which outlives
   * both this call and any particular device row (see the schema's own
   * comment on `devices.kind`), so there is nothing here for Mullion to
   * persist. `address`/`password` are validated by the route before this is
   * reached — see routes/devices.ts's own comment on why that validation is
   * an allowlist, not shell-style escaping (this never touches a shell). */
  async pair(address: string, password: string): Promise<void> {
    this.assertEnabled();
    await this.serverClient.wireless.pair(address, password);
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
