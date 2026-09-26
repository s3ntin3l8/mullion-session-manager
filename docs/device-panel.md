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

### Stream tuning

The emulator has no hardware H.264 encoder, so every streamed frame is
encoded in software on the same guest vCPUs that render it. A phone-native
screen (e.g. 1344×2992) is far more pixels than a panel of a few hundred CSS
pixels can show, so the stream is bounded by default:

| Variable                | Default                | Meaning                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICE_VIDEO_MAX_SIZE` | `1280`                 | Longest side of the streamed video, px (scrcpy `--max-size`). `0` = native.                                                                                                                                                                                                                                                                                                         |
| `DEVICE_VIDEO_MAX_FPS`  | `60`                   | Frame-rate cap (scrcpy `--max-fps`). `0` = uncapped.                                                                                                                                                                                                                                                                                                                                |
| `DEVICE_VIDEO_BIT_RATE` | `8000000`              | H.264 bit rate, bits/s. Lower it for a remote viewer.                                                                                                                                                                                                                                                                                                                               |
| `DEVICE_EMULATOR_GPU`   | `swiftshader_indirect` | Emulator `-gpu` mode. The default is software rendering (works headless anywhere). `host` uses the host GPU but needs a GL/EGL display — a headless container typically has none and the emulator exits with `Failed to get EGL display` (the Vulkan device itself is visible) — so it is opt-in and unverified headless. Other common values: `auto`, `swangle_indirect`, `guest`. |

These bound the **stream** only — `tap`/`swipe`/`screenshot` still operate at
native screen resolution. If the guest itself renders slowly (software
SwiftShader drawing a 4-megapixel screen), lowering the AVD's own `hw.lcd`
resolution helps more than any stream setting — the encoder and the software
renderer compete for the same guest CPUs. In the browser, the pane draws frames with WebGL when available and
falls back to a slower bitmap renderer otherwise.

---

## Architecture & Lifecycle

Mirrors the session model's own "DB row is intent, an in-memory manager is
live truth" split (see `AGENTS.md`'s "non-obvious session model" note) —
deliberately a **separate** implementation from `PtyManager`/
`session-process.ts`, not a generalization of them (see
`src/services/device-process.ts`'s own header for why).

- **`devices` table** (`src/db/schema.ts`) — one row per Android device
  Mullion manages, either kind. `kind: "emulator"` rows work as described
  below; `kind: "physical"` rows (a phone connected over adb **wireless
  debugging**) get a row too, keyed on `serial` (the adb TCP address)
  instead of `avdName`/`port` — every route, the WS panel, the CLI, and MCP
  all address a device by its numeric row id, so a row-less physical device
  would need a parallel identifier scheme through all of them. Mullion never
  _spawns_ a physical device (no systemd scope, no marker, no port pool
  slot) — only connects to one the user already paired; see
  `Device.connectPhysical()`'s own comment. Pairing (`adb pair`) writes into
  the adb **server's** own keystore, which outlives Mullion restarts, so
  reconnect-after-restart needs nothing persisted beyond the address itself:
  `getOrCreate()` just calls `wireless.connect()` again. A killed physical
  row does **not** disconnect the phone from the host's adb server — that
  connection table is shared with the user's own adb tooling, outside
  Mullion's ownership.
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

  **Wire protocol.** Server→client video frames are binary:
  `[1 byte type][1 byte flags][payload]` — `type` `0` = configuration
  (SPS/PPS), `1` = data; `flags` bit 0 = keyframe. There is deliberately no
  `pts` field — receive-time pacing is enough for a live, audio-less stream.
  Frames are cached per packet object (a `WeakMap`), so N attached sockets
  fanned out from one `Device` don't each re-encode the same packet. The
  server can also send out-of-band **JSON text frames** on the same socket:
  `{"type":"error","message":string}` (a `getOrCreate()` failure, socket
  closed right after) and `{"type":"exited"}` (the device process died,
  socket closed right after). Client→server messages are JSON text frames, a
  `type`-discriminated union: `tap`/`touchDown`/`touchMove`/`touchUp`/
  `scroll` (all carry `x`/`y` plus `videoWidth`/`videoHeight` — the device's
  **video-pixel space**, see §1 below — touch messages also carry
  `pointerId`), `text` (`{text: string}`), `keyEvent`
  (`{androidKeyCode: number, action: "down"|"up"}`), and `back` (no fields).
  Neither a malformed (unparseable JSON, server-logged) nor an unrecognized
  (valid JSON, wrong shape, silently ignored) message ever produces an error
  frame back to the client — see `parseInputMessage`'s own comment.

- **`DevicePane.tsx`** decodes with
  [`@yume-chan/scrcpy-decoder-webcodecs`](https://www.npmjs.com/package/@yume-chan/scrcpy-decoder-webcodecs)
  (WebCodecs `VideoDecoder` under the hood) onto a `<canvas>` — needs a
  current Chromium-based browser; shows an explicit "unsupported" state
  otherwise.

**Wired into the dashboard UI (issue #1326, lifecycle rework).** The sidebar
shows a "Devices" section, above Projects, listing every device row that still
exists — active _and_ stopped. There's no manual expand/collapse for it; the
section simply doesn't render at all while there are zero devices (see below).
A row's status dot reflects its live state, a stopped row renders dimmed with
a **Start** control (an active row gets **Stop** instead), and clicking the row
itself opens (or focuses) that device's panel via `openDevicePanel`
(`panelUtils.ts`) — deliberately starting it first when it was stopped, since a
panel pointed at a stopped device is just a 404ing websocket. The section
renders nothing while there are zero devices, so it stays out of the way on a
host that never touches Android; its poll runs unconditionally regardless, so a
device created purely through the CLI/MCP surface below (no panel ever opened)
still makes the section appear without a reload.

Settings → Devices is the lifecycle surface — create, pair, and, on _every_
row regardless of status: start, stop, edit a physical device's adb address,
and delete. Delete is the irreversible half (it removes the row, which is what
clears a pre-existing row stuck in the list); stop keeps the row and lists it
as `stopped`. It's also where a phone gets paired and connected (the
`kind: "physical"` counterpart to an emulator `create`, see §1 below, and the
pairing dialog described next), and where a new AVD can be provisioned from an
installed system image (see "AVD provisioning" below) before a device is ever
created from it.

Reopening a device panel after a Mullion restart resumes streaming from the
existing emulator (see the reattach behavior above) rather than requiring a
manual `systemctl --user stop` first. A restored layout that points at a
device which has since been stopped or deleted closes that panel instead of
restarting the device as a side effect of a page load — reopening it from the
sidebar (which now lists stopped rows) starts it deliberately.

Pairing a phone from Settings (issue #1379) uses **Pair a phone or tablet**,
which opens `PairDeviceDialog.tsx` (the emulator flow sits behind its own
**Create an emulator** button). The dialog polls `GET /api/devices/discovered`
(issue #1378's mDNS snapshot) and lists phones that are advertising Wireless
debugging. A phone that is only advertising its connect port (the phone is
already paired, or its "Pair device with pairing code" screen is closed) is
shown but can't be picked. The user picks a phone, enters the 6-digit code, and
one **Pair & Connect** click calls `POST /api/devices/pair-and-connect`, which
pairs, connects and creates the device row in a single request. If nothing is
found within ~3 s, a **Pair manually** form opens (scanning continues above
it). This form is the fallback for networks mDNS can't reach, and it takes the
pairing address, the device (connect) address and the code, since the endpoint
needs both ports in manual mode. The per-row **Edit address** button stays as
the post-hoc override when Android rotates the connect port.

**Reconnect prompt (issue #1380).** Android picks a new connect port every time
Wireless debugging is toggled, which used to strand a paired phone until the
user clicked **Edit address** (issue #1347). When `DEVICE_DISCOVERY_ENABLED` is
on, Settings → Devices polls `GET /api/devices/discovered` every ~5 s (only
while an active physical row exists and the tab is visible) and compares it
with the stored rows. A row whose stored address is no longer advertised, but
whose host is (or, if the phone also changed IP, whose name matches the
advertised name/model), gets an inline **Reconnect to _name_?** note. Clicking it
sends the same `PATCH /api/devices/:id` as Edit address — no new row, no new
protocol, and never without a click. When several phones or rows match (for
example two Pixels behind one host), the note lists one button per candidate
instead. The name-only fallback can also match a _different_ phone that shares
the advertised name/model while the real one is offline, so that case is always
shown as a confirm-style prompt. If the phone needs a fresh pairing code, delete and re-pair as before.
The prompt only appears when mDNS can reach the device; otherwise **Edit
address** remains the manual path.

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
mullion device pair <pairingAddress> <code>
mullion device pair-and-connect [--discovery-id <id> | --pairing-address <addr>] --connect-address <addr> --pairing-code <code> [--name <label>]
mullion device connect <address> [--project <id>] [--name <label>]
mullion device discovered
mullion device start <id>
mullion device stop <id>
mullion device delete <id>
mullion device screenshot <id> [--out <path>]
mullion device tap <id> <x> <y>
mullion device swipe <id> <x1> <y1> <x2> <y2> [<durationMs>]
mullion device text <id> <text...>
mullion device key <id> <androidKeyCode>
mullion device logcat <id> [--lines <n>] [--filter <expr>]
```

`pair`/`connect` are two separate steps because Android's Wireless debugging
screen shows two separate addresses — a one-time pairing address/code, and a
longer-lived connect address — and they're not the same port. `pair` doesn't
create a device row (see the `devices` table bullet above); `connect` does,
and is the `kind: "physical"` counterpart to `create`. `pair-and-connect`
(added in issue #1378) collapses both steps into one CLI call and is the
text-equivalent of the new "Pair a phone" modal — supply `--discovery-id`
(use `mullion device discovered` to find one) to drive pair+connect from a
cached mDNS entry, or `--pairing-address` to type both ports by hand.

`x`/`y` (and `x1 y1 x2 y2`) are in the device's native **screen pixels** —
the same space a `screenshot` comes back in, since `tap`/`swipe` run as
`adb shell input`. This is deliberately _not_ the live stream's video-pixel
space: the panel's stream is downscaled (see "Stream tuning" above), and
`DevicePane.tsx` rescales its own mouse events into that video space before
sending them over the WebSocket.

`tap`/`swipe`/`key`/`screenshot`/`logcat` all run as plain `adb shell`
commands against the device's live adb connection
(`Device.adbConnection`) — they work independently of whether the device's
video panel is currently open anywhere, and do **not** go through the
scrcpy control channel the live panel uses. **`text` is the one exception**:
`routes/devices.ts` routes it through `device.controller.injectText()` — the
same scrcpy control channel the live WS panel's own "text" input message
uses (`routes/device.ts`'s `dispatchInput`) — rather than `adb shell input
text`, since `injectText` needs no shell at all. It 400s if no scrcpy
controller exists yet (a narrow window during boot, after adb comes up but
before scrcpy does) rather than falling back to the shell.

## 2. `mullion mcp` tools

`list_devices`, `start_device`, `stop_device` and `use_device`/`device_action`
mirror the CLI 1:1 — see `src/mcp/tools.mjs`. Unlike most control-socket-backed
tools (`list_sessions`, `list_projects`, ...), these are reachable at **session
scope**, not just full scope: a device has no "belongs to this session"
relationship to pin a session-scoped connection to the way a browser pane's
project does, so `deviceId` is always explicit, at either scope, and a
session-scoped caller is not restricted to any particular device (see
`control-socket.ts`'s own comment on `device.action` for the full reasoning).
This is what actually closes the "verify your own UI change" loop the feature
exists for — an agent inside a normal session can call these with no elevated
credential. Stop is reachable there too: it's reversible, and an agent that can
stop a device can start it again.

Three things are **full scope only**, all gated on the same "bigger blast
radius than driving a device Mullion already manages" reasoning: `device.pair`
always, `device.create` when its body sets `kind: "physical"` (session
scope still works for an ordinary emulator `device.create`) — `wireless.connect()`
lets the caller dial an arbitrary address, an outbound-dial/internal-network-
probe primitive the emulator path never had (see `control-socket.ts`'s own
comments on both) — and `delete_device`/`device delete`, which drops the row
and the id that identifies its systemd scope with no undo. MCP does not expose
`device pair`/`connect` — only the CLI and REST do.

## 3. REST API

`src/routes/devices.ts` — `GET/POST /api/devices`, `POST /api/devices/pair`,
`POST /api/devices/pair-and-connect`, `GET /api/devices/discovered`,
`GET/PATCH/DELETE /api/devices/:id`, `POST /api/devices/:id/start`,
`POST /api/devices/:id/stop`, `POST /api/devices/:id/action` (body:
`{action: "screenshot"|"tap"|"swipe"|"text"|"key"|"logcat", ...}`, same shape
the CLI/MCP surface forwards). Lifecycle: `POST /:id/start` flips a stopped row
back to `active` and runs `getOrCreate()` so something is actually running
behind it. Errors: 400 when `getOrCreate()` throws — synchronously, so a
stopped row is reverted to `killed` and never left "active" with nothing
behind it; a physical row's adb connect failure is fire-and-forget inside
`getOrCreate()`, so like a physical `POST /api/devices` it surfaces on the
device's own live error instead of as a 400 here — 409 when
another **active** physical row already owns this row's address — the same
one-active-row-per-adb-address guard create, pair-and-connect and PATCH apply
(issue #1350) — and 404 for a row that no longer exists. Start also re-reads
the row after `getOrCreate()` resolves, because that call awaits and a whole
`DELETE` or `/stop` can land while it is in flight: the later write wins, and
the scope that was just made is torn back down with it (404 for the deleted
row, 409 "device was stopped while starting" for the stopped one), so neither
race can leave a scope running where no control can reach it. `POST /:id/stop`
flips the row to `killed` and tears the live process/scope down, **keeping
the row** — the reversible half; `DELETE /:id`
is the irreversible one, tearing the live thing down first and then **removing
the row** (two-phase: if teardown throws it returns 500 and keeps the row,
marked `killed`, so the deletion never reports success for something still
half-alive). `POST /api/devices` takes either
`{avdName, projectId?, name?}` (emulator) or `{kind: "physical", address,
projectId?, name?}` (physical); `POST /api/devices/pair` takes
`{pairingAddress, pairingCode}` and creates no row.
`POST /api/devices/pair-and-connect` (issue #1378) takes either
`{discoveryId, pairingCode, connectAddress?, name?}` (drives pair+connect
from the cached mDNS snapshot returned by `GET /api/devices/discovered`)
or `{pairingAddress, connectAddress, pairingCode, name?}` (manual fallback
for networks where mDNS doesn't reach — both ports must be supplied). It
inserts the row first (sync collision guard → 409 if an active physical
row already owns the same connect address), then awaits pair() — a wrong
code rolls the insert back and returns 400 so an immediate retry re-pairs
instead of hitting 409 — then kicks off connect fire-and-forget and
returns 201. Connect failures after that surface asynchronously via the
device's own `status`/`error`, not as a 400 from this endpoint. `GET /api/devices/discovered` returns the current mDNS snapshot
(an empty array when `DEVICE_DISCOVERY_ENABLED=false` or nothing has been
advertised). `PATCH /api/devices/:id`
(issue #1347) takes `{address}` and is **physical-only** (an emulator's
`serial` is synthesized from its own `port` column, not user-supplied) — it
rewrites the row's `serial` in place (keeping `id`/`name`/`projectId`/
history) and reconnects at the new address, tearing down any existing live
`Device` first so a stale connection at the old address can't linger. It is
**physical-only, any status** — a stopped phone is exactly when Android has
rotated its connect port, so the address stays editable there, and editing a
stopped row persists the new `serial` without implicitly starting the device.
An active row whose new address is already owned by another active row is a 409. No CLI/MCP
counterpart: `wireless.connect()` on an arbitrary caller-supplied address is
the same "bigger blast radius" outbound-dial primitive `device.create`
(`kind: "physical"`) and `device.pair` are already gated `["full"]`-scope
only for (see `src/plugins/control-socket.ts`'s own comments on both) — a
control-socket `device.update` op would need that same gate plus its own
review, descoped here as a REST/Settings-only feature (issue #1347 named
Settings → Devices explicitly). The control-socket ops above are thin
wrappers over these same routes (`injectAndShape`), same "CLI/MCP piggyback
on the REST layer" pattern the browser automation ops use.

## 4. AVD provisioning

Gated by `DEVICE_ENABLED` like everything else above, plus two more
`DEVICE_*` config vars this half of the feature needs on top of it:
`DEVICE_AVDMANAGER_PATH` (the `avdmanager` binary from the SDK's
cmdline-tools) and `DEVICE_ANDROID_SDK_ROOT` (the SDK root, for scanning
installed system images). Both empty by default, same "not configured"
posture as `DEVICE_ADB_PATH`/`DEVICE_EMULATOR_PATH` — see
[`configuration.md`](configuration.md).

This is provisioning state on the host's **SDK install**, not a `devices`
DB row — `src/services/avd-manager.ts` is the counterpart to
`device-manager.ts`'s _running_ half, and deliberately lives in its own
route module, `src/routes/avds.ts` (the "one file per route module"
convention `devices.ts`'s own header documents). **Creating an AVD here
does not create a `devices` row** — a user still adds a device for it
afterward via `POST /api/devices {avdName}` (§3 above), the same way
`kind: "emulator"` has always worked.

- **`GET /api/avds`** — `avdmanager list avd`, parsed from its `Name:` lines.
  This is what feeds the "New device" form's AVD picker.
- **`GET /api/device-profiles`** — `avdmanager list device`, parsed from its
  `id: N or "..."` lines (the token `-d` actually accepts, not the
  human-readable `Name:` line below it, which can contain spaces/parens
  `-d` doesn't take verbatim). The profile list comes from the
  `nexus.xml` bundled inside the installed cmdline-tools' own sdklib jar,
  so its freshness is bounded by **that** package's version — cmdline-tools
  12.0 tops out at Pixel 7, while cmdline-tools 22.0 and newer add the
  Pixel 8/9/10 family (`pixel_10a` arrives in 23.0). A host missing those
  profiles should upgrade in place: `sdkmanager "cmdline-tools;latest"`
  (with `--sdk_root=<root>` if your sdkmanager needs it), re-point
  `DEVICE_AVDMANAGER_PATH` / `DEVICE_SDKMANAGER_PATH` at
  `<root>/cmdline-tools/latest/bin/…` if they name a versioned bin dir,
  then restart Mullion.
- **`GET /api/system-images`** — lists system images **already installed**
  on this host, by scanning `<sdkRoot>/system-images/<api>/<tag>/<abi>/`
  directly on disk rather than shelling out to `avdmanager`/`sdkmanager` —
  measured empirically: `sdkmanager --list_installed` performs a remote
  repository fetch even for already-installed packages, and `--offline` is
  rejected alongside that flag, making it unusable for a route that just
  fills a dropdown. The three path segments under `system-images/` **are**
  the `-k`/`--package` value `avdmanager create avd` expects
  (`system-images;<api>;<tag>;<abi>`), so no separate package-id registry is
  needed; each leaf directory's `source.properties` is read for
  enrichment-only display fields (API level, tag, ABI) that fall back to
  `null` — never dropping the image — if that file is missing or corrupt.
- **`POST /api/avds`** — `{name, systemImage, deviceProfile}` →
  `avdmanager create avd -n <name> -k <systemImage> -d <deviceProfile>`.
  `name` is allowlisted against avdmanager's own accepted charset
  (alphanumerics, `.`, `_`, `-`); `systemImage`/`deviceProfile` are
  allowlisted against what `GET /api/system-images`/`GET /api/device-profiles`
  themselves just reported for this host, not regex-validated — strictly
  stronger, and free, since that data is already being fetched to populate
  the picker that produced these values in the first place. Always passes
  `-d` (suppresses avdmanager's "create a custom hardware profile?" prompt)
  and closes the child's stdin immediately, so any _other_ prompt it might
  ask (e.g. re-creating an existing name without `--force`, which this route
  deliberately never passes) fails fast on EOF instead of hanging until the
  route's own timeout. A name collision therefore surfaces as a clear
  "already exists" error rather than silently overwriting an existing AVD.

### System image management (issue #1348)

Gated by `DEVICE_SDKMANAGER_PATH` (the `sdkmanager` binary from the SDK's
cmdline-tools), which follows the same "empty means not configured" posture
as the other `DEVICE_*_PATH` vars.

- **`GET /api/system-images/available`** — runs `sdkmanager --list` against
  Google's repository, parses the tabular output into structured objects
  (`{packagePath, apiLevel, tag, tagDisplay, abi, installed}`), auto-filters
  by host ABI (`process.arch` → Android ABI mapping), and marks
  which are already installed locally. The parser accepts both stdout
  dialects: the classic Java sdkmanager (`Available Packages:` header,
  pipe-delimited columns, `system-images;…` semicolon paths) and the newer
  Android CLI under the sdkmanager deprecation shim (cmdline-tools ≥ ~23,
  lowercase `Available packages:`, space-aligned columns,
  `system-images/…` slash paths — normalized to semicolons at parse time).
  Results are cached in-memory for 5 minutes to avoid repeated network
  fetches. Returns 400 if `sdkmanager --list` times out (60s) or fails.
- **`/ws/system-image-install`** — WebSocket endpoint for install/uninstall
  operations. Accepts `{type: "install"|"uninstall", packagePath}` messages.
  Validates `packagePath` against the allowlist from `GET /api/system-images/available`
  before spawning the subprocess. Streams `{type: "progress", message}` lines
  from `sdkmanager --install`/`--uninstall` stdout, and `{type: "done"}` or
  `{type: "error", message, code?}` on completion. The optional `code` field
  is set to `"license"` when the failure is a license rejection — the frontend
  uses this to open the accept-licenses modal. Only one SDK operation at a time
  is allowed (concurrent requests get rejected with `{type: "error"}`).
- **`/ws/sdk-licenses`** — WebSocket endpoint for license acceptance.
  Accepts `{type: "accept-licenses"}` messages. Runs `yes | sdkmanager --licenses`
  on the host, streams progress lines, and reports done/error. Feeds stdin
  reactively (one `y\n` per `: ` prompt line, plus an initial `y\n` for the
  non-prompt "Review licenses" header) so it handles any number of pending
  licenses. Matches the exact stdout line `/^All SDK package licenses accepted\b/`
  for the success heuristic — not a loose `includes("accepted")` — and uses
  `armKillEscalation` (30 s) to prevent a hung process from latching the
  global SDK-operation lock.
- **`GET /api/sdk-licenses/status`** — returns `{pending: true}`. The license
  acceptance check is conservative: we can't know which hashes a fresh SDK
  requires without actually running `sdkmanager --licenses`, so the endpoint
  always reports licenses as potentially pending. The `acceptLicenses` call is
  idempotent — a fast no-op when licenses are already accepted.
