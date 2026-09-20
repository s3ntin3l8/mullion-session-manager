// AVD (Android Virtual Device) listing/creation — the counterpart to
// device-manager.ts's *running* half.
import { readdirSync, readFileSync, existsSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// System image management — install, uninstall, license acceptance, and
// listing available (not just installed) images from Google's repository.
// ---------------------------------------------------------------------------

const SDKMANAGER_LIST_TIMEOUT_MS = 60_000;
const SDKMANAGER_INSTALL_TIMEOUT_MS = 600_000; // 10 min — large downloads
const SDKMANAGER_UNINSTALL_TIMEOUT_MS = 120_000;

// Maps Node.js `process.arch` to Android SDK ABI names. Only architectures
// that both Node.js and the Android SDK support are listed — no MIPS (dead)
// and no 32-bit ARM on 64-bit hosts.
const ARCH_TO_ABI: Record<string, string> = {
  x64: "x86_64",
  ia32: "x86",
  arm64: "arm64-v8a",
  arm: "armeabi-v7a",
};

export interface AvailableSystemImage {
  packagePath: string;
  apiLevel: string;
  tag: string;
  tagDisplay: string;
  abi: string;
  installed: boolean;
}

// Parses a single line from `sdkmanager --list`'s pipe-delimited table.
// Returns [path, version, description] or null if the line doesn't match.
//   | system-images;android-35;google_apis;x86_64  | 7 | Google APIs ... |
const SDKMANAGER_LINE_RE = /^\s+(system-images;\S+)\s+\|\s+(\S+)\s+\|\s+(.+)$/;
const AVAILABLE_HEADER = "Available Packages:";

// Parses `sdkmanager --list` output and returns system image entries filtered
// to the host's architecture. Cross-references with the installed images set
// to set the `installed` flag.
export function parseSdkManagerList(
  output: string,
  installedImages: SystemImage[],
): AvailableSystemImage[] {
  const installedPaths = new Set(installedImages.map((img) => img.packagePath));
  const hostAbi = ARCH_TO_ABI[process.arch] ?? process.arch;
  const images: AvailableSystemImage[] = [];

  // Find the "Available Packages:" section — everything before it is
  // installed packages or header text we don't need.
  const availableIdx = output.indexOf(AVAILABLE_HEADER);
  const section = availableIdx >= 0 ? output.slice(availableIdx + AVAILABLE_HEADER.length) : output;

  for (const line of section.split("\n")) {
    const match = SDKMANAGER_LINE_RE.exec(line);
    if (!match) continue;
    const [, packagePath, _version, tagDisplay] = match;
    const parts = packagePath.split(";");
    if (parts.length !== 4) continue;
    const [, apiRaw, tag, abi] = parts;
    // Filter: only host-ABI images.
    if (abi !== hostAbi) continue;
    // Extract numeric API level from "android-35" or "android-VanillaIceCream".
    const apiLevel = apiRaw.replace(/^android-/, "");
    images.push({
      packagePath,
      apiLevel,
      tag,
      tagDisplay: tagDisplay.trim(),
      abi,
      installed: installedPaths.has(packagePath),
    });
  }

  // Sort by API level descending (newest first), then tag alphabetically.
  // Codename levels (e.g. "VanillaIceCream") sort to the top since they
  // represent unreleased previews and are numerically NaN.
  return images.sort((a, b) => {
    const aNum = parseInt(a.apiLevel, 10);
    const bNum = parseInt(b.apiLevel, 10);
    const aIsNaN = Number.isNaN(aNum);
    const bIsNaN = Number.isNaN(bNum);
    if (aIsNaN && !bIsNaN) return -1;
    if (!aIsNaN && bIsNaN) return 1;
    if (aIsNaN && bIsNaN) return a.apiLevel.localeCompare(b.apiLevel);
    const apiNum = bNum - aNum;
    if (apiNum !== 0) return apiNum;
    return a.tag.localeCompare(b.tag);
  });
}

// Lists available system images from Google's repository by shelling out to
// `sdkmanager --list`. This hits the network — callers should cache the
// result (the route layer caches with a 5-min TTL).
export async function listAvailableSystemImages(
  sdkmanagerPath: string,
  sdkRoot: string,
  opts: { execFileFn?: ExecFileFn } = {},
): Promise<AvailableSystemImage[]> {
  const { stdout } = await execFileWithEscalation(
    opts.execFileFn ?? execFileCb,
    sdkmanagerPath,
    ["--list", "--sdk_root", sdkRoot],
    SDKMANAGER_LIST_TIMEOUT_MS,
  );
  const installed = listInstalledSystemImages(sdkRoot);
  return parseSdkManagerList(stdout, installed);
}

// Installs a system image by shelling out to `sdkmanager --install`. Streams
// each stdout/stderr line to the caller via `onLine` for progress display.
export async function installSystemImage(
  sdkmanagerPath: string,
  sdkRoot: string,
  packagePath: string,
  opts: { onLine?: (line: string) => void; execFileFn?: ExecFileFn } = {},
): Promise<void> {
  const execFileFn = opts.execFileFn ?? execFileCb;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    // eslint-disable-next-line prefer-const
    let armed: ReturnType<typeof armKillEscalation> | undefined;
    const child = execFileFn(
      sdkmanagerPath,
      ["--install", packagePath, "--sdk_root", sdkRoot],
      (error, _stdout, stderr) => {
        if (settled) return;
        settled = true;
        armed?.clearOnSettle();
        if (error) {
          // sdkmanager --install with `yes | --licenses` exits 1 on some
          // SDK versions even when licenses are accepted — check stderr.
          const msg = typeof stderr === "string" && stderr.trim() ? stderr.trim() : error.message;
          reject(new Error(msg));
          return;
        }
        resolve();
      },
    );
    // Close stdin immediately to prevent interactive prompts (same defense
    // as createAvd).
    child.stdin?.end();
    // Stream stdout/stderr lines to the caller.
    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) opts.onLine?.(line.trim());
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) opts.onLine?.(line.trim());
      }
    });
    armed = armKillEscalation(child, SDKMANAGER_INSTALL_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `sdkmanager --install ${packagePath} timed out after ${SDKMANAGER_INSTALL_TIMEOUT_MS}ms`,
        ),
      );
    });
  });
}

// Uninstalls a system image by shelling out to `sdkmanager --uninstall`.
// Streams each stdout/stderr line to the caller via `onLine`.
export async function uninstallSystemImage(
  sdkmanagerPath: string,
  sdkRoot: string,
  packagePath: string,
  opts: { onLine?: (line: string) => void; execFileFn?: ExecFileFn } = {},
): Promise<void> {
  const execFileFn = opts.execFileFn ?? execFileCb;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    // eslint-disable-next-line prefer-const
    let armed: ReturnType<typeof armKillEscalation> | undefined;
    const child = execFileFn(
      sdkmanagerPath,
      ["--uninstall", packagePath, "--sdk_root", sdkRoot],
      (error, _stdout, stderr) => {
        if (settled) return;
        settled = true;
        armed?.clearOnSettle();
        if (error) {
          const msg = typeof stderr === "string" && stderr.trim() ? stderr.trim() : error.message;
          reject(new Error(msg));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end();
    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) opts.onLine?.(line.trim());
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) opts.onLine?.(line.trim());
      }
    });
    armed = armKillEscalation(child, SDKMANAGER_UNINSTALL_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `sdkmanager --uninstall ${packagePath} timed out after ${SDKMANAGER_UNINSTALL_TIMEOUT_MS}ms`,
        ),
      );
    });
  });
}

// Accepts all pending SDK licenses by piping `yes` to `sdkmanager --licenses`.
// Streams each stdout/stderr line to the caller via `onLine`.
//
// sdkmanager --licenses exits with code 1 on some SDK versions even when
// licenses ARE accepted — the caller should check for the "accepted" string
// in the output rather than trusting the exit code alone.
const ACCEPT_LICENSES_TIMEOUT_MS = 30_000;
export async function acceptLicenses(
  sdkmanagerPath: string,
  sdkRoot: string,
  opts: { onLine?: (line: string) => void } = {},
): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let armed: ReturnType<typeof armKillEscalation> | undefined;

    const child = spawn(sdkmanagerPath, ["--licenses", "--sdk_root", sdkRoot], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Declared (as `let`) BEFORE spawn() is armed — same pattern as
    // execFileWithEscalation; see that function's comment for why.
    // eslint-disable-next-line prefer-const
    armed = armKillEscalation(child, ACCEPT_LICENSES_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      reject(new Error(`sdkmanager --licenses timed out after ${ACCEPT_LICENSES_TIMEOUT_MS}ms`));
    });

    // Pipe "yes" to stdin to auto-accept all licenses.
    child.stdin.write("y\n");
    child.stdin.write("y\n");
    child.stdin.write("y\n");
    child.stdin.write("y\n");
    child.stdin.write("y\n");
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        if (line.trim()) opts.onLine?.(line.trim());
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim()) opts.onLine?.(line.trim());
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      armed?.clearOnSettle();
      // Treat as success if "accepted" appears in output, regardless of exit code.
      if (stdout.includes("accepted") || stderr.includes("accepted")) {
        resolve();
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `sdkmanager --licenses exited with code ${code}`,
        ),
      );
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      armed?.clearOnSettle();
      reject(err);
    });
  });
}

// Checks whether SDK licenses have been accepted by looking for the
// `licenses/` directory under the SDK root. If the directory doesn't exist
// or is empty, licenses are pending.
export function hasPendingLicenses(sdkRoot: string): boolean {
  const licensesDir = path.join(sdkRoot, "licenses");
  if (!existsSync(licensesDir)) return true;
  try {
    const entries = readdirSync(licensesDir, { withFileTypes: true });
    return entries.length === 0;
  } catch {
    return true;
  }
}
