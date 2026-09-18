# Android Device Panel

Mullion can run an Android emulator (or attach to a physical phone over adb)
on the host and stream its screen into a native dockview panel, alongside
your terminals — the Android analogue of the [Controllable
Browser](browser-automation.md). It also exposes a one-shot `mullion device`
CLI/MCP surface so an agent can screenshot, tap, and read logcat output to
verify its own UI changes, the same way it already can for the web via
`mullion browser`.

Gated by `DEVICE_ENABLED=true` (default off) — this needs real host
provisioning most deployments won't have: `/dev/kvm` passthrough, an
installed Android SDK emulator + system image, and the `scrcpy-server`
binary. See the `ansible-playbooks` repo's `lxc-kvm`/`android-sdk` roles.

---

## Architecture & Lifecycle

Mirrors the session model's own "DB row is intent, an in-memory manager is
live truth" split (see `AGENTS.md`'s "non-obvious session model" note) —
deliberately a **separate** implementation from `PtyManager`/
`session-process.ts`, not a generalization of them (see
`src/services/device-process.ts`'s own header for why).

- **`devices` table** (`src/db/schema.ts`) — one row per AVD Mullion has been
  asked to run. A **physical** device (a phone over adb) never gets a row:
  Mullion doesn't own its lifecycle, so `DeviceManager` surfaces it purely
  from adb's own live device list.
- **`DeviceManager`** (`src/services/device-manager.ts`) — an in-memory
  `Map<string, Device>`. Starting a device runs the emulator inside a
  transient `systemd --user` scope (`crs-device-<instanceId>-<id>`, same
  per-instance namespacing as a session's `crs-session-*` scope) — the
  underlying process does survive a Mullion redeploy, and Mullion
  **reattaches** to it: the `devices.port` DB column persists the adb port
  `Device.spawn()` allocated (written immediately, before `systemd-run` even
  runs, via `DeviceManagerOptions.onPortAssigned` — see that field's own
  comment on why immediately rather than after boot succeeds). When
  `getOrCreate()` finds a scope still running (`isScopeAlive()`) with no
  in-memory `Device` to represent it, it reconstructs the `emulator-<port>`
  serial from that persisted port and confirms the serial is still live on
  `adb devices` — awaited, so a confirmed-gone process (the emulator itself
  died, not just Mullion) rejects `getOrCreate()` immediately with a clear
  error, the same way the WS route already surfaces a getOrCreate() failure
  to the client, rather than hanging in a boot-wait poll loop that was never
  going to succeed or failing silently inside a fire-and-forget call the
  route would never observe. Once confirmed alive, it attaches a **fresh**
  `AdbScrcpyClient` to the already-running emulator (`Device.attach()`,
  fire-and-forget from here on, same as a normal spawn) — skipping
  `systemd-run`/`buildDeviceLaunchPlan`/`touchDeviceMarker` entirely, since
  the emulator process itself is already up; only the adb+scrcpy connection
  needs (re)establishing. A failure past this point (a transient adb hiccup,
  say) never stops the scope — `attach()` didn't create it, and the process
  is already confirmed alive, so only the connection attempt itself gets
  torn down; a later `getOrCreate()` call simply retries. The only case that
  still needs a manual `systemctl --user stop` is a scope that survived with
  **no persisted port to reattach with** (a row from before this column
  existed, or one whose `Device` never got far enough to record one) —
  `getOrCreate()` still surfaces that plainly, naming the command, rather
  than colliding with the leftover scope's still-occupied unit name.
  Reattaching does **not** resume the exact same scrcpy session state (e.g.
  mid-gesture) — only that the emulator process is still running and worth
  resuming a stream to; scrcpy is stateless from the client's perspective, so
  starting a fresh connection against an already-running emulator is normal,
  expected usage. Port reservation isn't limited to devices that have
  actually been reattached to, either: `allocatePort()`'s round-robin scan
  only sees ports recorded in its own in-memory set, which starts empty on
  every boot, so `src/plugins/device.ts` pre-populates it at construction
  from every `status: "active"` row's persisted `port` column — a
  restart-surviving device sitting untouched since boot (nobody has called
  `getOrCreate()` for it yet, so `reservePort()` never fired) still keeps its
  port out of the pool a brand-new device's fresh `spawn()` draws from.
  `getOrCreate()` releases a pre-populated port again as soon as it can
  positively confirm that device's own scope/process is actually gone (both
  the no-scope-survived fallthrough and the scope-alive-but-adb-can't-see-it
  branch above) — otherwise a device whose emulator died independently of
  Mullion (a host reboot, a crash) while its row stayed `status: "active"`
  would strand that pool slot for the rest of the process's lifetime.
  Populated synchronously (better-sqlite3, no plugin-registration ordering
  issue). Currently a no-op on the multi-host "agent" role: `devicePlugin`
  registers there too, but with no `app.db` to read a persisted port from at
  all (same `app.db ? ... :` fallback posture as `hooksPlugin`,
  `src/plugins/hooks.ts`) — every `devices` row today is `hostId: "local"`
  anyway (`src/routes/devices.ts` never sets it from a request), so this is
  a latent gap rather than an active one, not a claim that the agent role is
  unaffected in principle.
- **Scope ownership**, unlike a session's, isn't anchored on a real dtach
  socket (an emulator has neither dtach nor a PTY) — `device-process.ts`
  makes `systemd-run` set the scope's `Description` explicitly to a
  self-controlled marker string, embedding the same
  `<sessionsDir>/<id>` ownership shape a session's dtach socket path
  provides. That marker is backed by a real, empty file
  (`touchDeviceMarker`/`removeDeviceMarker`) specifically so
  `scripts/check-scope-leaks.ts`'s existing leak heuristics apply to
  `crs-device-*` scopes unmodified — a leaked emulator holds a KVM handle
  and several GB, worse than a leaked shell.
- **`/ws/device/:deviceId`** (`src/routes/device.ts`) streams H.264 video
  packets to the frontend `DevicePane` and proxies touch/scroll/key/text
  input back, fanned out from the one live `Device` to however many panels
  are attached — push-based, not polled, unlike the Controllable Browser's
  JPEG-screenshot-on-a-timer stream. Backpressure only ever drops a `data`
  packet, never a `configuration` one (SPS/PPS — the decoder can't start
  without it), and requests a fresh keyframe (`resetVideo()`) once a
  backlog clears, instead of leaving the frontend decoder to free-run
  against a stream with a hole in it.
- **`DevicePane.tsx`** decodes with
  [`@yume-chan/scrcpy-decoder-webcodecs`](https://www.npmjs.com/package/@yume-chan/scrcpy-decoder-webcodecs)
  (WebCodecs `VideoDecoder` under the hood) onto a `<canvas>` — needs a
  current Chromium-based browser; shows an explicit "unsupported" state
  otherwise.

**Not yet wired into the dashboard UI.** There's no "open a device panel"
button in Settings or the pane menu yet — a device is opened today by
constructing its panel id (`device-<id>`, `component: "device"`) via
`openDevicePanel` (`panelUtils.ts`) from your own code, or by driving it
entirely through the CLI/MCP surface below, which needs no panel open at
all. A proper device list/create UI is tracked as a follow-up. Reopening a
device panel after a Mullion restart now resumes streaming from the
existing emulator (see the reattach behavior above) rather than requiring a
manual `systemctl --user stop` first — no UI change needed for that; it's
the same `openDevicePanel`/WS-connect path either way.

---

## 1. `mullion device` CLI

Every action verb takes the device's numeric row id (from `device list`) as
its first positional argument — no implicit "default device"/`ANDROID_SERIAL`
fallback (a deliberate v1 scope trim, tracked as a follow-up: with more than
one device attached, an implicit default is exactly the silent ambiguity this
CLI's own explicit-id convention avoids elsewhere).

```bash
mullion device list
mullion device create <avdName> [--project <id>] [--name <label>]
mullion device stop <id>
mullion device screenshot <id> [--out <path>]
mullion device tap <id> <x> <y>
mullion device swipe <id> <x1> <y1> <x2> <y2> [<durationMs>]
mullion device text <id> <text...>
mullion device key <id> <androidKeyCode>
mullion device logcat <id> [--lines <n>] [--filter <expr>]
```

`x`/`y` (and `x1 y1 x2 y2`) are in the device's **video-pixel space**, not
CSS pixels — the same coordinate space `DevicePane.tsx` rescales mouse events
into before sending them.

`tap`/`swipe`/`text`/`key`/`screenshot`/`logcat` all run as plain `adb shell`
commands against the device's live adb connection
(`Device.adbConnection`) — they work independently of whether the device's
video panel is currently open anywhere, and do **not** go through the
scrcpy control channel the live panel uses.

## 2. `mullion mcp` tools

`list_devices` and `use_device`/`device_action` mirror the CLI 1:1 — see
`src/mcp/tools.mjs`. Unlike most control-socket-backed tools (`list_sessions`,
`list_projects`, ...), these are reachable at **session scope**, not just
full scope: a device has no "belongs to this session" relationship to pin a
session-scoped connection to the way a browser pane's project does, so
`deviceId` is always explicit, at either scope, and a session-scoped caller
is not restricted to any particular device (see `control-socket.ts`'s own
comment on `device.action` for the full reasoning). This is what actually
closes the "verify your own UI change" loop the feature exists for — an
agent inside a normal session can call these with no elevated credential.

## 3. REST API

`src/routes/devices.ts` — `GET/POST /api/devices`, `GET/DELETE
/api/devices/:id`, `POST /api/devices/:id/action` (body: `{action:
"screenshot"|"tap"|"swipe"|"text"|"key"|"logcat", ...}`, same shape the CLI/
MCP surface forwards). The control-socket ops above are thin wrappers over
these same routes (`injectAndShape`), same "CLI/MCP piggyback on the REST
layer" pattern the browser automation ops use.
