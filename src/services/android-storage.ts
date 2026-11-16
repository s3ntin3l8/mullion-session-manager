import fs from "node:fs/promises";
import { constants as fsConstants, type Dirent } from "node:fs";
import path from "node:path";
import { avdConfigRoots, uninstallSystemImage, type ExecFileFn } from "./avd-manager.js";
import { dirSize } from "./temp-storage.js";
import type { CleanupStepResult } from "./disk-cleanup-job.js";

// Opt-in cleanup of Android SDK system images no AVD uses (issue #3086).
//
// Two rules carry the safety. (1) Fail closed: an image counts as unreferenced
// only when EVERY AVD under every AVD root was read and parsed; one unreadable
// `config.ini` could name any image, so nothing is offered or removed.
// (2) Removal is `sdkmanager --uninstall` only, never a directory delete, so
// the SDK's own bookkeeping stays consistent.

export const ANDROID_PRUNE_IN_PROGRESS = "ANDROID_PRUNE_IN_PROGRESS";

export interface AndroidImagesOptions {
  /** `DEVICE_ANDROID_SDK_ROOT`; empty means not configured. */
  sdkRoot: string;
  /** `DEVICE_SDKMANAGER_PATH`; empty means not configured. */
  sdkmanagerPath: string;
  /** Directories holding AVDs. Defaults to the SDK's own discovery. */
  avdRoots?: readonly string[];
  execFileFn?: ExecFileFn;
}

export interface AndroidImage {
  /** `system-images;<api>;<tag>;<abi>`, the value `sdkmanager --uninstall` takes. */
  packagePath: string;
  bytes: number;
}

export type AndroidImagesInspection =
  | { available: false; error: string; images: []; reclaimableBytes: 0 }
  | { available: true; images: AndroidImage[]; reclaimableBytes: number };

function unavailable(error: string): AndroidImagesInspection {
  return { available: false, error, images: [], reclaimableBytes: 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

// `key=value` lines of an AVD's `config.ini` / `<name>.ini`. Later keys win,
// as in the SDK's own reader.
function parseIni(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Every AVD directory under the roots: each `<name>.avd` directory, and the
 * `path=` each `<name>.ini` pointer names (an AVD may live elsewhere). A root
 * that does not exist has no AVDs; one that cannot be listed is an error.
 */
async function discoverAvdDirs(roots: readonly string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const root of new Set(roots.map((r) => path.resolve(r)))) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw new Error(`cannot list the AVD folder ${root}: ${message(error)}`, { cause: error });
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.name.endsWith(".avd")) {
        // A symlink to a directory counts; a plain file named *.avd does not.
        const stat = await fs.stat(full).catch(() => null);
        if (stat?.isDirectory()) dirs.add(full);
        else throw new Error(`${full} is not a readable AVD folder`);
      } else if (entry.name.endsWith(".ini")) {
        let pointer: Map<string, string>;
        try {
          pointer = parseIni(await fs.readFile(full, "utf8"));
        } catch (error) {
          throw new Error(`cannot read ${full}: ${message(error)}`, { cause: error });
        }
        const target = pointer.get("path");
        const rel = pointer.get("path.rel");
        if (target) dirs.add(path.resolve(target));
        else if (rel) dirs.add(path.resolve(path.dirname(root), rel));
        else throw new Error(`${full} names no AVD path`);
      }
    }
  }
  return [...dirs];
}

/**
 * The image directories (relative to `<sdk>/system-images`, as segment lists)
 * that some AVD points at. Throws when any AVD cannot be read or names no
 * image: the caller then offers and removes nothing.
 */
async function referencedImagePrefixes(
  sdkRoot: string,
  roots: readonly string[],
): Promise<string[][]> {
  const imagesRoot = path.join(path.resolve(sdkRoot), "system-images");
  const realImagesRoot = await fs.realpath(imagesRoot).catch(() => imagesRoot);
  const prefixes: string[][] = [];
  for (const dir of await discoverAvdDirs(roots)) {
    const configPath = path.join(dir, "config.ini");
    let config: Map<string, string>;
    try {
      config = parseIni(await fs.readFile(configPath, "utf8"));
    } catch (error) {
      throw new Error(`cannot read ${configPath}: ${message(error)}`, { cause: error });
    }
    const sysdirs = [...config.entries()].filter(([key]) => /^image\.sysdir\.\d+$/.test(key));
    if (sysdirs.length === 0) throw new Error(`${configPath} names no system image`);
    for (const [, raw] of sysdirs) {
      const value = raw.replace(/\\/g, "/");
      if (value.length === 0) throw new Error(`${configPath} has an empty image.sysdir`);
      const resolved = path.resolve(sdkRoot, value);
      // Lexically and through symlinks: either spelling of the SDK root counts.
      const real = await fs.realpath(resolved).catch(() => resolved);
      for (const [candidate, base] of [
        [resolved, imagesRoot],
        [real, realImagesRoot],
      ] as const) {
        const rel = path.relative(base, candidate);
        if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
        // `rel === ""` is the whole system-images folder: it covers every image.
        prefixes.push(rel === "" ? [] : rel.split(path.sep));
      }
    }
  }
  return prefixes;
}

// An image is referenced when a sysdir is the image directory, lies inside it,
// or is a parent of it (a shorter path could mean any image below it).
function isReferenced(segments: string[], prefixes: string[][]): boolean {
  return prefixes.some((prefix) => {
    const n = Math.min(prefix.length, segments.length);
    return prefix.slice(0, n).every((part, i) => part === segments[i]);
  });
}

async function installedImages(sdkRoot: string): Promise<string[][]> {
  const base = path.join(path.resolve(sdkRoot), "system-images");
  const out: string[][] = [];
  const subdirs = async (dir: string): Promise<string[]> => {
    try {
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  };
  for (const api of await subdirs(base)) {
    for (const tag of await subdirs(path.join(base, api))) {
      for (const abi of await subdirs(path.join(base, api, tag))) out.push([api, tag, abi]);
    }
  }
  return out;
}

async function sdkmanagerProblem(sdkmanagerPath: string): Promise<string | null> {
  if (!sdkmanagerPath) return "sdkmanager is not configured (DEVICE_SDKMANAGER_PATH)";
  try {
    await fs.access(sdkmanagerPath, fsConstants.X_OK);
    return null;
  } catch {
    return `sdkmanager not found or not executable at ${sdkmanagerPath}`;
  }
}

const packageOf = (segments: string[]) => `system-images;${segments.join(";")}`;

/** Images no AVD refers to, with their sizes. Fails closed (see the header). */
export async function inspectAndroidImages(
  options: AndroidImagesOptions,
): Promise<AndroidImagesInspection> {
  if (!options.sdkRoot) return unavailable("DEVICE_ANDROID_SDK_ROOT is not configured");
  try {
    await fs.stat(options.sdkRoot);
  } catch {
    return unavailable(`the Android SDK folder ${options.sdkRoot} does not exist`);
  }
  const problem = await sdkmanagerProblem(options.sdkmanagerPath);
  if (problem) return unavailable(problem);
  try {
    const prefixes = await referencedImagePrefixes(
      options.sdkRoot,
      options.avdRoots ?? avdConfigRoots(),
    );
    const images: AndroidImage[] = [];
    for (const segments of await installedImages(options.sdkRoot)) {
      if (isReferenced(segments, prefixes)) continue;
      images.push({
        packagePath: packageOf(segments),
        bytes: await dirSize(
          path.join(path.resolve(options.sdkRoot), "system-images", ...segments),
        ),
      });
    }
    return {
      available: true,
      images,
      reclaimableBytes: images.reduce((sum, image) => sum + image.bytes, 0),
    };
  } catch (error) {
    return unavailable(`Nothing removed: ${message(error)}`);
  }
}

let pruning = false;

/**
 * Uninstalls every unreferenced image through `sdkmanager --uninstall`, one at
 * a time. The references are read again right before each one, so an AVD
 * created meanwhile protects its image.
 */
export async function pruneAndroidImages(
  options: AndroidImagesOptions,
): Promise<CleanupStepResult> {
  if (pruning) throw new Error(ANDROID_PRUNE_IN_PROGRESS);
  pruning = true;
  try {
    const found = await inspectAndroidImages(options);
    if (!found.available) return { reclaimedBytes: 0, skipped: found.error };
    let reclaimedBytes = 0;
    const removed: string[] = [];
    for (const image of found.images) {
      const segments = image.packagePath.split(";").slice(1);
      try {
        const prefixes = await referencedImagePrefixes(
          options.sdkRoot,
          options.avdRoots ?? avdConfigRoots(),
        );
        if (isReferenced(segments, prefixes)) continue;
        await uninstallSystemImage(options.sdkmanagerPath, options.sdkRoot, image.packagePath, {
          execFileFn: options.execFileFn,
        });
      } catch (error) {
        return {
          reclaimedBytes,
          output: removed.join("\n") || undefined,
          error: `${image.packagePath}: ${message(error)}`,
        };
      }
      removed.push(image.packagePath);
      reclaimedBytes += image.bytes;
    }
    return { reclaimedBytes, output: removed.length > 0 ? removed.join("\n") : undefined };
  } finally {
    pruning = false;
  }
}
