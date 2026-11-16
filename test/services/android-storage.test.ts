import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ANDROID_PRUNE_IN_PROGRESS,
  inspectAndroidImages,
  pruneAndroidImages,
} from "../../src/services/android-storage.js";

const USED = "system-images;android-35;google_apis;x86_64";
const SPARE = "system-images;android-37.2;google_apis_ps16k;x86_64";

let tmp: string;
let sdk: string;
let avdHome: string;
let sdkmanager: string;
let argvLog: string;

function writeImage(pkg: string, bytes = 1000) {
  const dir = path.join(
    sdk,
    ...pkg.split(";").map((part, i) => (i === 0 ? "system-images" : part)),
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "system.img"), Buffer.alloc(bytes));
}

function writeAvd(name: string, config: string) {
  const dir = path.join(avdHome, `${name}.avd`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.ini"), config);
}

const options = () => ({ sdkRoot: sdk, sdkmanagerPath: sdkmanager, avdRoots: [avdHome] });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "android-storage-"));
  sdk = path.join(tmp, "sdk");
  avdHome = path.join(tmp, "avd");
  fs.mkdirSync(sdk);
  fs.mkdirSync(avdHome);
  argvLog = path.join(tmp, "argv.log");
  sdkmanager = path.join(tmp, "sdkmanager");
  // Records its argv one line per call, then really removes the image so the
  // test sees the same end state sdkmanager would leave.
  fs.writeFileSync(
    sdkmanager,
    `#!/bin/sh\necho "$@" >> "${argvLog}"\nif [ "$1" = "--uninstall" ]; then\n  rel=$(echo "$2" | tr ';' '/')\n  rm -rf "${sdk}/$rel"\nfi\n`,
    { mode: 0o755 },
  );
  writeImage(USED, 3000);
  writeImage(SPARE, 8000);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const argv = () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8").trim() : "");

describe("inspectAndroidImages", () => {
  it("offers only the image no AVD uses, with its size", async () => {
    writeAvd("pixel", "image.sysdir.1=system-images/android-35/google_apis/x86_64/\n");
    const result = await inspectAndroidImages(options());
    expect(result.available).toBe(true);
    expect(result.images.map((i) => i.packagePath)).toEqual([SPARE]);
    expect(result.reclaimableBytes).toBeGreaterThanOrEqual(8000);
    expect(result.reclaimableBytes).toBeLessThan(12_000);
  });

  it("lists every image when there are no AVDs at all", async () => {
    fs.rmSync(avdHome, { recursive: true });
    const result = await inspectAndroidImages(options());
    expect(result.images.map((i) => i.packagePath)).toEqual([USED, SPARE]);
  });

  it("treats a sysdir that is only a parent folder as covering what is below it", async () => {
    writeAvd("a", "image.sysdir.1=system-images/android-35/\n");
    writeAvd("b", "image.sysdir.1=system-images/android-37.2/google_apis_ps16k/x86_64\n");
    expect((await inspectAndroidImages(options())).images).toEqual([]);
  });

  it("resolves an absolute sysdir and a Windows-style one", async () => {
    writeAvd(
      "a",
      `image.sysdir.1=${path.join(sdk, "system-images", "android-35", "google_apis", "x86_64")}/\n`,
    );
    writeAvd("b", "image.sysdir.1=system-images\\android-37.2\\google_apis_ps16k\\x86_64\\\n");
    expect((await inspectAndroidImages(options())).images).toEqual([]);
  });

  it("follows an AVD pointer .ini to an AVD outside the root", async () => {
    const elsewhere = path.join(tmp, "elsewhere.avd");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(
      path.join(elsewhere, "config.ini"),
      "image.sysdir.1=system-images/android-37.2/google_apis_ps16k/x86_64/\n",
    );
    writeAvd("pixel", "image.sysdir.1=system-images/android-35/google_apis/x86_64/\n");
    fs.writeFileSync(path.join(avdHome, "far.ini"), `path=${elsewhere}\n`);
    expect((await inspectAndroidImages(options())).images).toEqual([]);
  });

  it("fails closed when an AVD config.ini cannot be read", async () => {
    writeAvd("pixel", "image.sysdir.1=system-images/android-35/google_apis/x86_64/\n");
    fs.mkdirSync(path.join(avdHome, "broken.avd")); // no config.ini
    const result = await inspectAndroidImages(options());
    expect(result).toMatchObject({ available: false, images: [], reclaimableBytes: 0 });
    expect(result.available === false && result.error).toContain("config.ini");
  });

  it("fails closed when a config.ini names no image, or a pointer names no path", async () => {
    writeAvd("odd", "hw.ramSize=2048\n");
    expect((await inspectAndroidImages(options())).available).toBe(false);
    fs.rmSync(path.join(avdHome, "odd.avd"), { recursive: true });
    fs.writeFileSync(path.join(avdHome, "ptr.ini"), "target=x\n");
    expect((await inspectAndroidImages(options())).available).toBe(false);
  });

  it("is unavailable without an SDK root, with a missing one, or without sdkmanager", async () => {
    expect(await inspectAndroidImages({ ...options(), sdkRoot: "" })).toMatchObject({
      available: false,
    });
    expect(
      await inspectAndroidImages({ ...options(), sdkRoot: path.join(tmp, "nope") }),
    ).toMatchObject({ available: false });
    expect(await inspectAndroidImages({ ...options(), sdkmanagerPath: "" })).toMatchObject({
      available: false,
    });
    expect(
      await inspectAndroidImages({ ...options(), sdkmanagerPath: path.join(tmp, "missing") }),
    ).toMatchObject({ available: false });
  });
});

describe("pruneAndroidImages", () => {
  it("never uninstalls a referenced image; uninstalls the other with the exact argv", async () => {
    writeAvd("pixel", "image.sysdir.1=system-images/android-35/google_apis/x86_64/\n");
    const result = await pruneAndroidImages(options());
    expect(argv()).toBe(`--uninstall ${SPARE} --sdk_root=${sdk}`);
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(8000);
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(path.join(sdk, "system-images", "android-35"))).toBe(true);
  });

  it("runs nothing when a config.ini is unreadable", async () => {
    fs.mkdirSync(path.join(avdHome, "broken.avd"));
    const result = await pruneAndroidImages(options());
    expect(result).toMatchObject({ reclaimedBytes: 0 });
    expect(result.skipped).toContain("config.ini");
    expect(argv()).toBe("");
  });

  it("skips with a reason when sdkmanager cannot be found", async () => {
    const result = await pruneAndroidImages({
      ...options(),
      sdkmanagerPath: path.join(tmp, "gone"),
    });
    expect(result.skipped).toContain("sdkmanager");
    expect(fs.existsSync(path.join(sdk, "system-images", "android-37.2"))).toBe(true);
  });

  it("removes every image one at a time when there are no AVDs", async () => {
    fs.rmSync(avdHome, { recursive: true });
    await pruneAndroidImages(options());
    expect(argv().split("\n")).toEqual([
      `--uninstall ${USED} --sdk_root=${sdk}`,
      `--uninstall ${SPARE} --sdk_root=${sdk}`,
    ]);
  });

  it("stops at the first failure and reports what was freed", async () => {
    fs.rmSync(avdHome, { recursive: true });
    fs.writeFileSync(sdkmanager, "#!/bin/sh\necho boom >&2\nexit 1\n", { mode: 0o755 });
    const result = await pruneAndroidImages(options());
    expect(result.reclaimedBytes).toBe(0);
    expect(result.error).toContain(USED);
  });

  it("refuses to run twice at once", async () => {
    fs.rmSync(avdHome, { recursive: true });
    const first = pruneAndroidImages(options());
    await expect(pruneAndroidImages(options())).rejects.toThrow(ANDROID_PRUNE_IN_PROGRESS);
    await first;
  });
});
