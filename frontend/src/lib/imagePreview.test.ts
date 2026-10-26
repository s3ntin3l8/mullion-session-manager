import { describe, it, expect } from "vitest";
import { imageMimeFor } from "./imagePreview.js";

describe("imageMimeFor", () => {
  it.each([
    ["a.png", "image/png"],
    ["dir/photo.JPG", "image/jpeg"],
    ["x.jpeg", "image/jpeg"],
    ["logo.svg", "image/svg+xml"],
    ["fav.ico", "image/x-icon"],
    ["a.b.webp", "image/webp"],
  ])("%s -> %s", (name, mime) => expect(imageMimeFor(name)).toBe(mime));

  it.each(["notes.txt", "Makefile", ".png-notes", "archive.png.zip", "dir.png/file"])(
    "%s is not an image",
    (name) => expect(imageMimeFor(name)).toBeNull(),
  );
});
