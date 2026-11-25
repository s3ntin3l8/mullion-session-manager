import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pngDimensions } from "../screenshot-image.js";
import type { SimctlRunner } from "./simctl.js";
import { DeviceActionError } from "./types.js";

// The iOS Simulator driver's screenshot (#1943, #3517).

const SCREENSHOT_MAX_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `simctl io <udid> screenshot` into a private temp file, read back and
 * checked. Never `-` for stdout: Xcode 27's simctl writes a file literally
 * named `-` into its working directory instead, and prints nothing on stdout
 * (#3517). The directory is removed whatever happens. */
export async function simctlScreenshot(simctl: SimctlRunner, udid: string): Promise<Uint8Array> {
  // mkdtemp creates the directory 0700, so no other user can read or swap the file.
  const dir = await mkdtemp(join(tmpdir(), "mullion-simctl-shot-"));
  const file = join(dir, "screenshot.png");
  try {
    let stderr: Buffer = Buffer.alloc(0);
    const stdout = await simctl(["io", udid, "screenshot", "--type=png", file], {
      onStderr: (b) => {
        stderr = b;
      },
    });
    const size = await stat(file).then(
      (st) => st.size,
      () => 0,
    );
    if (size > SCREENSHOT_MAX_BYTES) {
      throw new DeviceActionError(
        502,
        `screencap returned ${size} bytes, over the ${SCREENSHOT_MAX_BYTES}-byte limit`,
      );
    }
    const out = size > 0 ? await readFile(file) : Buffer.alloc(0);
    if (!PNG_SIGNATURE.equals(out.subarray(0, 8))) {
      // What simctl said, or else what it wrote: the first 200 bytes, scrubbed.
      const said = Buffer.concat([stderr, stdout]);
      const head = (said.length > 0 ? said : out)
        .subarray(0, 200)
        .toString("utf8")
        .trim()
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
      throw new DeviceActionError(502, `screencap did not return a PNG: ${head}`);
    }
    const png = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    if (!pngDimensions(png)) {
      throw new DeviceActionError(502, "screencap returned a PNG with no readable header");
    }
    return png;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
