// Image types the file browser previews inline. SVG is included on purpose:
// it is only ever shown through a blob: URL in an <img> (no script execution),
// never as a document.
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
};

/** Largest image the preview will pull into memory. */
export const MAX_IMAGE_PREVIEW_BYTES = 25 * 1024 * 1024;

/** The image MIME type a file name previews as, or null if it isn't one. */
export function imageMimeFor(fileName: string): string | null {
  const base = fileName.split("/").pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_MIME[base.slice(dot + 1).toLowerCase()] ?? null;
}
