# Spike: idb for an iOS Simulator device panel (#3199)

Run 2026-11-17 on an Apple-silicon Mac, Xcode 27.2, iOS 26.5 runtime, against a
**throwaway simulator** (`xcrun simctl create mullion-spike …`, deleted
afterwards; no existing simulator was touched).

Tooling: `idb_companion` 1.7.8 (`brew install facebook/fb/idb-companion`,
Homebrew warns Xcode 27 is a Tier 2 configuration), `fb-idb` 1.7.7 client in a
throwaway venv.

## Verdict

**Go**, with `idb_companion` as the video and input engine and `simctl` for
lifecycle, screenshot, logs and clipboard. Two things are not yet proven and
must be closed in #3203 (see "Not tested").

## Findings

### Video: `idb video-stream --format h264 --fps 30`

- **Annex-B**, 4-byte start codes (`00 00 00 01`). No container, no length
  prefixes. Exactly what a NAL splitter wants.
- **SPS, PPS and an IDR come first** (NAL order `7, 8, 5, 1, 1, …`), so a late
  joiner gets a decodable start without asking.
- **IDR cadence is ~120 frames (4 s at 30 fps)** (IDRs at slice 1, 123, 243).
  A new browser tab would wait up to 4 s for a keyframe unless the driver
  caches the last SPS/PPS/IDR group or restarts the stream
  (`requestKeyframe()` = restart is the fallback; scrcpy has `resetVideo`).
- SPS header `27 64 00 32` gives **High profile, level 5.0**, so the WebCodecs
  codec string is `avc1.640032`. Derive it from the SPS per stream rather than
  hard-coding it.
- Companion's own stats: 29.9 fps, **~670 kbps**, ~1.8 ms/frame encode, 0
  dropped, 0 encode errors. Companion idles around 1.6% CPU and 34 MB RSS.
- Frame size equals the screenshot: **1206x2622 px** on an iPhone 17.

### Browser decode (WebCodecs, Chrome)

A 258-frame capture (3 IDRs) was split on 4-byte start codes, grouped into
access units (SPS+PPS+IDR together, every other slice alone) and fed to a
`VideoDecoder` configured with `avc1.640032` and **no `description`**, i.e.
Annex-B passthrough. `isConfigSupported` was true; **258 of 258 frames decoded
at 1206x2622 with zero errors** (288 ms for the whole clip, a bulk decode and not
a latency figure). So the driver can forward idb's NALs as they are: no
AVCC conversion and no `description`, with SPS+PPS sent in front of each IDR.

### Input

- `idb ui tap|swipe|button|text` all work. A tap focused Safari's URL bar and
  `text hello` typed into it (verified from a screenshot).
- **Coordinates are points, not pixels.** `idb describe` reports
  `width=1206 height=2622 density=3.0 width_points=402 height_points=874`, and
  `describe-point 200 830` hit the URL button whose frame is `{89,819,224,21}`.
  The driver converts the panel's pixel coordinates by dividing by `density`.
- **Each CLI call costs 0.36 to 2.7 s** (a Python process plus a gRPC connect per
  call: tap 0.36 s and 2.73 s on two runs, swipe 1.43 s with `--duration 0.3`,
  button 0.46 s, text 0.36 s). That is fine for `mullion device` actions and
  useless for live drag. Live touch needs the companion's gRPC `hid` stream
  held open, from Node, which is also the plan's recommendation.
- `ui button HOME` works.

### Companion lifecycle

- One `idb_companion --udid <udid> --grpc-port <n>` per simulator.
- `simctl shutdown` does **not** kill the companion, but its HID connection is
  invalidated: after a reboot, `ui tap` fails with
  `The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated`.
  The video stream also drops ("Connection closed before the stream
  completed").
- **Killing and restarting the companion after the simulator boots fixes it**
  (tap succeeded on the restarted companion). So the driver must own the
  companion process and restart it on every boot, which fits the plan's
  "restarted on reattach".

## Not tested (carry into #3203)

1. **Direct gRPC `hid` touch down/move/up from Node.** Only the CLI path was
   measured. The latency conclusion above is why this matters; if gRPC proves
   impractical, a long-lived Python `idb` process is the fallback.
2. **Sustained CPU and latency under real use** (only a ~65 s idle-ish run, not
   glass-to-glass latency).

## Fallback

WebDriverAgent was not evaluated since idb worked. Cost if ever needed: a
signed XCTest runner per simulator and a build step on the host, which is far
heavier than a brew-installed companion.

## Decisions for the implementation issues

- Driver owns one companion per device, restarted after each boot (#3203).
- Cache the latest SPS+PPS+IDR so a new client decodes immediately, instead of
  waiting up to 4 s (#3203).
- Convert px to points with the `density` from `describe` (#3203, #3204).
- Treat the `fb-idb` Python client as dev-only; production talks gRPC to the
  companion (#3203).
