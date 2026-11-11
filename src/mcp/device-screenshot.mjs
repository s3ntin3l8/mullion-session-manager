// Issue #2884 — `use_device` screenshots as MCP image content.

/** Default `use_device` screenshot width (issue #2884). */
export const DEVICE_SCREENSHOT_DEFAULT_WIDTH = 720;

/** Turn the device.action screenshot reply into an image block plus a text
 * block stating the scale, so coordinates read off the image can be mapped
 * back to the native pixels tap/swipe expect. */
function screenshotResult(r) {
  if (typeof r?.screenshot !== "string" || !r.screenshot) {
    throw new Error("device screenshot reply carried no image");
  }
  const nativeW = r.nativeWidth ?? r.width;
  const nativeH = r.nativeHeight ?? r.height;
  const scale = r.width && nativeW ? nativeW / r.width : 1;
  const text =
    scale > 1.0001
      ? `Returned ${r.width}x${r.height} of native ${nativeW}x${nativeH}; multiply image coordinates by ${Number(scale.toFixed(4))} to get tap/swipe pixels.`
      : `Native size ${nativeW}x${nativeH}; image coordinates equal tap/swipe pixels.`;
  return {
    content: [
      { type: "image", mimeType: r.mimeType ?? "image/png", data: r.screenshot },
      { type: "text", text },
    ],
  };
}

/** Fetch a (by default downscaled) screenshot and shape it as MCP content. */
export async function deviceScreenshot(client, deviceId, actionPayload) {
  const payload = {
    ...actionPayload,
    maxWidth: actionPayload.maxWidth ?? DEVICE_SCREENSHOT_DEFAULT_WIDTH,
  };
  return screenshotResult(await client.deviceAction(deviceId, payload));
}
