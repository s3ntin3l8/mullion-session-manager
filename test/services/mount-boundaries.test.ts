import { describe, expect, it } from "vitest";
import { parseDarwinMounts, parseLinuxMountInfo } from "../../src/services/mount-boundaries.js";

describe("mount table parsers", () => {
  it("reads Linux mountpoints, including escaped paths and bind mounts", () => {
    expect(
      parseLinuxMountInfo(
        "12 1 8:1 / / rw - ext4 /dev/sda rw\n13 12 8:1 /src /tmp/work\\040tree/bind rw - ext4 /dev/sda rw\n",
      ),
    ).toEqual(["/", "/tmp/work tree/bind"]);
    expect(() => parseLinuxMountInfo("invalid")).toThrow();
  });
  it("reads macOS mountpoints and refuses ambiguous records", () => {
    expect(
      parseDarwinMounts(
        "/dev/disk1 on / (apfs, local)\n/dev/disk2 on /Volumes/Work (apfs, local)\n",
      ),
    ).toEqual(["/", "/Volumes/Work"]);
    expect(() => parseDarwinMounts("not a mount listing")).toThrow();
  });
});
