// AVD (Android Virtual Device) listing/creation — the counterpart to
// device-manager.ts's *running* half. Mirrors src/services/opencode-models.ts's
// `ExecFn`-injection pattern for the two commands that just list things
// (listAvds, listDeviceProfiles): a real exec is the default, tests inject a
// fake, no real `avdmanager` process ever runs in CI. `createAvd` needs its
// own, different shape — see that function's own comment on why.
import { readdirSync, readFileSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFileCb);

export type ExecFn = (
  file: string,
  args: string[],
  options: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args, options) =>
  execFileP(file, args, { signal: options.signal });

const LIST_TIMEOUT_MS = 15_000;
// avdmanager's own `create avd` step reaches out to fetch/refresh its local
// repository cache (observed empirically — a few seconds even when nothing
// is actually downloaded), on top of whatever time the image-copy itself
// takes. Generous, but still a hard cap: this is a foreground HTTP request
// from routes/avds.ts, not a background job.
const CREATE_AVD_TIMEOUT_MS = 120_000;

// Self-review (mullion-reviewer) caught a real bug in an earlier version of
// this function: racing `exec()` against a second, separately-scheduled
// `setTimeout` that rejected on its own left THAT timer's handle uncleared
// on the success path, leaking a pending timer for up to LIST_TIMEOUT_MS
// after every single call — confirmed empirically to add up to 15s to a
// script's exit. `execFile`'s own `signal` option is sufficient on its
// own — a real `execFile` given a firing AbortSignal already rejects the
// promise — so there is no need for a second, independent timeout
// mechanism at all: one timer, captured and cleared in `finally`.
async function runList(exec: ExecFn, avdmanagerPath: string, args: string[]): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const { stdout } = await exec(avdmanagerPath, args, { signal: controller.signal });
    return stdout;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`avdmanager ${args.join(" ")} timed out`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  opts: { exec?: ExecFn } = {},
): Promise<string[]> {
  const stdout = await runList(opts.exec ?? defaultExec, avdmanagerPath, ["list", "avd"]);
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
  opts: { exec?: ExecFn } = {},
): Promise<string[]> {
  const stdout = await runList(opts.exec ?? defaultExec, avdmanagerPath, ["list", "device"]);
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
  return images;
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

// A raw `child_process.execFile` reference, NOT promisified — unlike
// `ExecFn` above (listAvds/listDeviceProfiles), createAvd needs the
// synchronously-returned ChildProcess itself to close its stdin immediately
// (see below), which promisify's callback-to-Promise wrapper doesn't expose.
export type ExecFileFn = typeof execFileCb;

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
// that appears when it's omitted, and stdin closed immediately means any
// OTHER prompt this binary might ever ask (also verified: re-creating an
// existing AVD name without `--force` asks one) fails fast on EOF instead of
// hanging until timeoutMs. Deliberately does NOT pass `--force` — a
// duplicate name should surface as a clear "already exists" error, not
// silently overwrite an existing AVD.
//
// `execFile` (not `exec`) — argv array, never a shell — and the `timeout`
// option is execFile's own hard cap (SIGTERMs the child), on top of the
// stdin-close defense above.
export function createAvd(opts: CreateAvdOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? CREATE_AVD_TIMEOUT_MS;
  const execFileFn = opts.execFileFn ?? execFileCb;
  return new Promise((resolve, reject) => {
    const child = execFileFn(
      opts.avdmanagerPath,
      ["create", "avd", "-n", opts.name, "-k", opts.systemImage, "-d", opts.deviceProfile],
      { timeout: timeoutMs },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end();
  });
}
