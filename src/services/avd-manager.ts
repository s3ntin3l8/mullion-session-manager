// AVD (Android Virtual Device) listing/creation — the counterpart to
// device-manager.ts's *running* half.
import { readdirSync, readFileSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { armKillEscalation } from "./session-process.js";

// A raw `child_process.execFile` reference (callback style, not
// promisified) — every exec-based function below needs the
// synchronously-returned ChildProcess itself, both to arm the
// SIGTERM-then-SIGKILL escalation every other timed subprocess in this repo
// uses (armKillEscalation, session-process.ts) and, for createAvd, to close
// stdin immediately (see that function's own comment). Tests inject a fake
// matching this same shape so no real `avdmanager` process ever runs in CI.
export type ExecFileFn = typeof execFileCb;

const LIST_TIMEOUT_MS = 15_000;
// avdmanager's own `create avd` step reaches out to fetch/refresh its local
// repository cache (observed empirically — a few seconds even when nothing
// is actually downloaded), on top of whatever time the image-copy itself
// takes. Generous, but still a hard cap: this is a foreground HTTP request
// from routes/avds.ts, not a background job.
const CREATE_AVD_TIMEOUT_MS = 120_000;

// Runs `file args...` via execFile, arming the same SIGTERM-then-SIGKILL
// escalation every other timed subprocess in this repo uses
// (armKillEscalation, session-process.ts's own doc comment on why) rather
// than execFile's own `timeout` option: Node's `timeout` only ever sends
// SIGTERM and leaves the returned promise unsettled until the child
// actually exits — a stalled `avdmanager` (its `create` step does network
// I/O) can hold a SIGTERM'd-but-still-alive child past the caller's own
// timeout indefinitely, defeating the point of having one at all (Hermes
// review). `onSpawn`, if given, runs synchronously against the live child
// before any output arrives — createAvd uses it to close stdin immediately.
function execFileWithEscalation(
  execFileFn: ExecFileFn,
  file: string,
  args: string[],
  timeoutMs: number,
  onSpawn?: (child: ReturnType<ExecFileFn>) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Declared (as `let`, not `const`) BEFORE execFileFn() is even called —
    // the settle-callback below references `armed` even though it's only
    // assigned AFTER that call returns. Safe today only because a real
    // execFile's callback always fires asynchronously; this ordering
    // removes the temporal-dead-zone fragility entirely rather than relying
    // on that timing assumption never changing (Hermes review). Exactly one
    // assignment follows, but it can't happen at declaration time — that's
    // the whole point of splitting it out — so `prefer-const` doesn't apply
    // here despite the usual "only assigned once" signal it looks for.
    // eslint-disable-next-line prefer-const
    let armed: ReturnType<typeof armKillEscalation> | undefined;
    const child = execFileFn(file, args, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      armed?.clearOnSettle();
      if (error) {
        const message = typeof stderr === "string" && stderr.trim() ? stderr.trim() : error.message;
        reject(new Error(message));
        return;
      }
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
      });
    });
    onSpawn?.(child);
    armed = armKillEscalation(child, timeoutMs, () => {
      if (settled) return;
      settled = true;
      reject(new Error(`${file} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    });
  });
}

// `avdmanager list avd` output shape (verified against a real SDK
// install — no machine-readable format is offered):
//
//   Available Android Virtual Devices:
//       Name: pixel_7
//     Device: pixel_7 (Google)
//       Path: /home/user/.android/avd/pixel_7.avd
//     Target: Google APIs (Google Inc.)
//             Based on: Android API 35 Tag/ABI: google_apis/x86_64
//     Sdcard: 512 MB
//   ---------
//       Name: ...
//
// Also tolerate a leading `Warning: This version only understands SDK XML
// versions up to N but an SDK XML file of version M was encountered...`
// line the binary prints on a newer-SDK-than-cmdline-tools host — it's on
// its own line before "Available Android Virtual Devices:", not interleaved
// with entries, so the name-line regex below already ignores it without any
// special-casing.
const AVD_NAME_LINE = /^\s*Name:\s*(.+)$/gm;

export async function listAvds(
  avdmanagerPath: string,
  opts: { execFileFn?: ExecFileFn } = {},
): Promise<string[]> {
  const { stdout } = await execFileWithEscalation(
    opts.execFileFn ?? execFileCb,
    avdmanagerPath,
    ["list", "avd"],
    LIST_TIMEOUT_MS,
  );
  return [...stdout.matchAll(AVD_NAME_LINE)].map((m) => m[1].trim());
}

// `avdmanager list device` output shape:
//
//   Available devices definitions:
//   id: 0 or "pixel_6"
//       Name: Pixel 6
//       OEM : Google
//   ---------
//   id: 1 or "Galaxy Nexus"
//       Name: Galaxy Nexus
//       OEM : Google
//
// The quoted token after `id: N or ` is the identifier `-d` accepts — NOT
// the human-readable "Name:" line below it (a device's display name can
// contain spaces/parens that `-d` doesn't accept verbatim the same way).
const DEVICE_PROFILE_ID_LINE = /^id:\s*\d+\s*or\s*"([^"]+)"/gm;

export async function listDeviceProfiles(
  avdmanagerPath: string,
  opts: { execFileFn?: ExecFileFn } = {},
): Promise<string[]> {
  const { stdout } = await execFileWithEscalation(
    opts.execFileFn ?? execFileCb,
    avdmanagerPath,
    ["list", "device"],
    LIST_TIMEOUT_MS,
  );
  return [...stdout.matchAll(DEVICE_PROFILE_ID_LINE)].map((m) => m[1]);
}

export interface SystemImage {
  // The `-k`/`--package` value `avdmanager create avd` accepts verbatim —
  // also this image's stable identifier (used for the POST /api/avds
  // allowlist check).
  packagePath: string;
  apiLevel: string | null;
  tagDisplay: string | null;
  abi: string | null;
}

// Parses a Java-properties-style `key=value` file (one entry per line, `#`
// comments, no quoting/escaping) — exactly `source.properties`' own format.
// Never throws: a missing or malformed line is silently skipped, since every
// field this reads is enrichment-only (see listInstalledSystemImages's own
// comment).
function parseProperties(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return result;
}

// Scans `<sdkRoot>/system-images/<api>/<tag>/<abi>/` — the three path
// segments ARE the `-k`/`--package` value avdmanager expects
// (`system-images;<api>;<tag>;<abi>`), so this needs no separate package-id
// registry, unlike `listAvds`/`listDeviceProfiles` above. Deliberately pure
// fs, no exec: `sdkmanager --list_installed` (the "official" way to ask this
// question) was measured performing a remote repository fetch even for
// already-installed packages, and `--offline` is rejected alongside that
// flag — unusable for a route that just fills a dropdown. Offline, instant,
// and trivially testable against a fixture directory tree instead.
//
// Sorted by packagePath before returning (Hermes review) — readdirSync's
// own order is unspecified, so without this the system-image picker's
// option order would be nondeterministic across hosts/filesystems.
export function listInstalledSystemImages(sdkRoot: string): SystemImage[] {
  const systemImagesDir = path.join(sdkRoot, "system-images");
  const images: SystemImage[] = [];
  for (const apiDir of safeReaddir(systemImagesDir)) {
    for (const tagDir of safeReaddir(path.join(systemImagesDir, apiDir))) {
      for (const abiDir of safeReaddir(path.join(systemImagesDir, apiDir, tagDir))) {
        const packagePath = `system-images;${apiDir};${tagDir};${abiDir}`;
        const propsPath = path.join(systemImagesDir, apiDir, tagDir, abiDir, "source.properties");
        // Enrichment only — a missing or corrupt source.properties still
        // yields a usable entry (packagePath alone is enough for both
        // -k/--package and the allowlist check), never drops the image.
        let props: Map<string, string>;
        try {
          props = parseProperties(readFileSync(propsPath, "utf8"));
        } catch {
          props = new Map();
        }
        images.push({
          packagePath,
          apiLevel: props.get("AndroidVersion.ApiLevel") ?? null,
          tagDisplay: props.get("SystemImage.TagDisplay") ?? null,
          abi: props.get("SystemImage.Abi") ?? null,
        });
      }
    }
  }
  return images.sort((a, b) => a.packagePath.localeCompare(b.packagePath));
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Missing sdkRoot/system-images dir (SDK not installed, or
    // DEVICE_ANDROID_SDK_ROOT misconfigured) — an empty list, not a thrown
    // error, so the route can 200 with `[]` rather than 500.
    return [];
  }
}

export interface CreateAvdOptions {
  avdmanagerPath: string;
  name: string;
  systemImage: string;
  deviceProfile: string;
  timeoutMs?: number;
  execFileFn?: ExecFileFn;
}

// `avdmanager create avd -k <systemImage> -d <deviceProfile>` — verified
// empirically against a real SDK install: passing `-d` unconditionally
// suppresses the "do you wish to create a custom hardware profile?" prompt
// that appears when it's omitted, and closing stdin immediately (via
// execFileWithEscalation's own `onSpawn` hook) means any OTHER prompt this
// binary might ever ask (also verified: re-creating an existing AVD name
// without `--force` asks one) fails fast on EOF instead of hanging until
// timeoutMs. Deliberately does NOT pass `--force` — a duplicate name should
// surface as a clear "already exists" error, not silently overwrite an
// existing AVD.
export async function createAvd(opts: CreateAvdOptions): Promise<void> {
  await execFileWithEscalation(
    opts.execFileFn ?? execFileCb,
    opts.avdmanagerPath,
    ["create", "avd", "-n", opts.name, "-k", opts.systemImage, "-d", opts.deviceProfile],
    opts.timeoutMs ?? CREATE_AVD_TIMEOUT_MS,
    (child) => child.stdin?.end(),
  );
}
