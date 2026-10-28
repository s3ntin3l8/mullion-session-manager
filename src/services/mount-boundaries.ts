import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const unescapeMountPath = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );

/** Mountpoints in this process's Linux mount namespace, including bind mounts. */
export function parseLinuxMountInfo(value: string): string[] {
  return value
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.split(" ");
      if (fields.length < 10 || !fields.includes("-") || !fields[4]?.startsWith("/")) {
        throw new Error("Invalid mountinfo");
      }
      return unescapeMountPath(fields[4]);
    });
}

/** On macOS, mount with no arguments lists the mounted filesystems. */
export function parseDarwinMounts(value: string): string[] {
  return value
    .trim()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf(" on ");
      const options = line.lastIndexOf(" (");
      if (separator < 0 || options <= separator || line.indexOf(" on ", separator + 4) !== -1) {
        throw new Error("Cannot parse mount list");
      }
      const mountpoint = unescapeMountPath(line.slice(separator + 4, options));
      if (!mountpoint.startsWith("/")) throw new Error("Invalid mountpoint");
      return mountpoint;
    });
}

export class UnsupportedMountPlatformError extends Error {}

/** True when a mount lies at or under this path. Unknown mount tables throw. */
export async function containsMount(target: string): Promise<boolean> {
  let mounts: string[];
  if (process.platform === "linux") {
    mounts = parseLinuxMountInfo(await fs.readFile("/proc/self/mountinfo", "utf8"));
  } else if (process.platform === "darwin") {
    mounts = parseDarwinMounts((await run("/sbin/mount", [], { timeout: 10_000 })).stdout);
  } else {
    throw new UnsupportedMountPlatformError("Mount detection is unavailable on this platform");
  }
  const resolved = path.resolve(target);
  return mounts.some((mount) => mount === resolved || mount.startsWith(resolved + path.sep));
}
