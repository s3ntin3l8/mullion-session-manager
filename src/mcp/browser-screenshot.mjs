// Issue #2899 — `browser_action` / `use_browser` screenshots as MCP image
// content.
//
// The hook reply is `{ ok, url, title, screenshot, snapshot, console, errors }`.
// `JSON.stringify` of that puts the PNG base64 on the text channel, and
// clients reject it as over the tool-output limit (the same failure as
// #2884: a ~140k-character line the model never sees). An image block
// carries the PNG; the text block keeps every other field, including the
// snapshot the agent clicks by ref.
//
// No downscale. Playwright's screenshot is the viewport in CSS pixels
// (deviceScaleFactor 1), not a multi-megapixel device frame, and click /
// scroll coordinates are those same CSS pixels — so the image stays 1:1
// and the text says so. `mullion browser screenshot --out` reads
// `result.screenshot` on the control-socket path and never comes through
// here, so that file is the same PNG.

/** Width/height from a PNG IHDR, or null. Local on purpose: this process is
 * plain `node` on `.mjs` and cannot import the TS decoder. */
function pngSize(base64) {
  const buf = Buffer.from(base64, "base64");
  if (buf.length < 24) return null;
  if (buf.toString("latin1", 0, 8) !== "\x89PNG\r\n\x1a\n") return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** String for every action except a screenshot that actually carried an
 * image. That one is an image block plus the reply without the base64. */
export function browserToolResult(args, result) {
  if (
    args?.action !== "screenshot" ||
    typeof result?.screenshot !== "string" ||
    result.screenshot.length === 0
  ) {
    return JSON.stringify(result);
  }
  const { screenshot, ...rest } = result;
  const dims = pngSize(screenshot);
  const note = dims
    ? `Screenshot ${dims.width}x${dims.height} CSS pixels; image coordinates equal CSS pixels.`
    : "Screenshot in CSS pixels; image coordinates equal CSS pixels.";
  return {
    content: [
      { type: "image", mimeType: "image/png", data: screenshot },
      { type: "text", text: `${note}\n${JSON.stringify(rest)}` },
    ],
  };
}
