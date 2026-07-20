import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_SUBDIR,
  extensionForMime,
  matchesMagicBytes,
  saveSessionUpload,
} from "../../src/services/session-upload.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_BYTES = Buffer.from("GIF89a\x00\x00\x00\x00", "latin1");
const WEBP_BYTES = Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1");

describe("session-upload", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), "tessera-upload-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("extensionForMime", () => {
    it("maps allow-listed image types", () => {
      expect(extensionForMime("image/png")).toBe(".png");
      expect(extensionForMime("image/jpeg")).toBe(".jpg");
      expect(extensionForMime("image/gif")).toBe(".gif");
      expect(extensionForMime("image/webp")).toBe(".webp");
    });

    it("returns null for anything not allow-listed", () => {
      expect(extensionForMime("image/svg+xml")).toBeNull();
      expect(extensionForMime("text/plain")).toBeNull();
      expect(extensionForMime("application/octet-stream")).toBeNull();
    });
  });

  describe("matchesMagicBytes", () => {
    it("accepts a buffer whose leading bytes match the declared mime's real signature", () => {
      expect(matchesMagicBytes(PNG_BYTES, "image/png")).toBe(true);
      expect(matchesMagicBytes(JPEG_BYTES, "image/jpeg")).toBe(true);
      expect(matchesMagicBytes(GIF_BYTES, "image/gif")).toBe(true);
      expect(matchesMagicBytes(WEBP_BYTES, "image/webp")).toBe(true);
    });

    it("rejects a buffer whose bytes don't match the declared mime (spoofed Content-Type)", () => {
      const html = Buffer.from("<html><script>alert(1)</script></html>");
      expect(matchesMagicBytes(html, "image/png")).toBe(false);
      expect(matchesMagicBytes(html, "image/jpeg")).toBe(false);
      expect(matchesMagicBytes(html, "image/gif")).toBe(false);
      expect(matchesMagicBytes(html, "image/webp")).toBe(false);
    });

    it("rejects cross-format mismatches (real image bytes, wrong claimed type)", () => {
      expect(matchesMagicBytes(PNG_BYTES, "image/jpeg")).toBe(false);
      expect(matchesMagicBytes(JPEG_BYTES, "image/png")).toBe(false);
    });

    it("rejects a buffer too short to contain the signature", () => {
      expect(matchesMagicBytes(Buffer.from([0x89, 0x50]), "image/png")).toBe(false);
      expect(matchesMagicBytes(Buffer.alloc(0), "image/png")).toBe(false);
    });

    it("returns false for a mime not in the allow-list, never throwing", () => {
      expect(matchesMagicBytes(PNG_BYTES, "image/svg+xml")).toBe(false);
    });
  });

  describe("saveSessionUpload", () => {
    it("writes the buffer under <cwd>/.tessera-uploads and returns an absolute path", () => {
      const buffer = Buffer.from("fake png bytes");

      const filePath = saveSessionUpload(cwd, buffer, "image/png");

      expect(path.isAbsolute(filePath)).toBe(true);
      expect(path.dirname(filePath)).toBe(path.join(path.resolve(cwd), UPLOAD_SUBDIR));
      expect(filePath.endsWith(".png")).toBe(true);
      expect(readFileSync(filePath)).toEqual(buffer);
    });

    it("seeds a .gitignore on first use so uploads never clutter git status", () => {
      saveSessionUpload(cwd, Buffer.from("x"), "image/jpeg");

      const gitignorePath = path.join(path.resolve(cwd), UPLOAD_SUBDIR, ".gitignore");
      expect(existsSync(gitignorePath)).toBe(true);
      expect(readFileSync(gitignorePath, "utf8")).toBe("*\n");
    });

    it("does not re-seed .gitignore on a second upload", () => {
      saveSessionUpload(cwd, Buffer.from("first"), "image/png");
      const gitignorePath = path.join(path.resolve(cwd), UPLOAD_SUBDIR, ".gitignore");
      const firstStat = readFileSync(gitignorePath, "utf8");

      saveSessionUpload(cwd, Buffer.from("second"), "image/png");

      expect(readFileSync(gitignorePath, "utf8")).toBe(firstStat);
    });

    it("generates a distinct filename per call, never trusting caller input", () => {
      const first = saveSessionUpload(cwd, Buffer.from("a"), "image/png");
      const second = saveSessionUpload(cwd, Buffer.from("b"), "image/png");

      expect(first).not.toBe(second);
    });

    it("throws for a mime type not in the allow-list", () => {
      expect(() => saveSessionUpload(cwd, Buffer.from("x"), "image/svg+xml")).toThrow(
        /Unsupported image type/,
      );
    });

    it("stays within the upload subdirectory regardless of a relative cwd", () => {
      const filePath = saveSessionUpload(cwd, Buffer.from("x"), "image/gif");
      const resolvedUploadDir = path.join(path.resolve(cwd), UPLOAD_SUBDIR);

      expect(filePath.startsWith(resolvedUploadDir + path.sep)).toBe(true);
    });
  });

  it("exports a sane MAX_UPLOAD_BYTES ceiling", () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024);
  });
});
