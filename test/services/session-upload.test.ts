import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { lutimesSync, utimesSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_SUBDIR,
  extensionForMime,
  matchesMagicBytes,
  pruneUploadDir,
  sanitizeUploadName,
  saveSessionFileUpload,
  saveSessionUpload,
} from "../../src/services/session-upload.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_BYTES = Buffer.from("GIF89a\x00\x00\x00\x00", "latin1");
const WEBP_BYTES = Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1");

describe("session-upload", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), "mullion-upload-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("extensionForMime", () => {
    it("does not resolve prototype keys as mime types", () => {
      expect(extensionForMime("constructor")).toBeNull();
      expect(extensionForMime("__proto__")).toBeNull();
    });

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
    it("writes the buffer under <cwd>/.mullion-uploads and returns an absolute path", () => {
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

  describe("sanitizeUploadName", () => {
    it("keeps a plain safe name unchanged", () => {
      expect(sanitizeUploadName("report-v2.final.pdf")).toBe("report-v2.final.pdf");
    });

    it("drops directory components (traversal) from POSIX and Windows paths", () => {
      expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
      expect(sanitizeUploadName("C:\\Users\\me\\doc.txt")).toBe("doc.txt");
    });

    it("replaces spaces, unicode and shell metacharacters with underscores", () => {
      expect(sanitizeUploadName("my résumé (1) $x.pdf")).toBe("my_r_sum___1___x.pdf");
    });

    it("strips leading dots so no hidden file or `..` can result", () => {
      expect(sanitizeUploadName(".bashrc")).toBe("bashrc");
      expect(sanitizeUploadName("..")).toBe("file");
    });

    it("falls back to `file` for an empty name or a bare directory path", () => {
      expect(sanitizeUploadName("")).toBe("file");
      expect(sanitizeUploadName("some/dir/")).toBe("file");
    });

    it("caps the length at 100 characters while keeping a normal extension", () => {
      const out = sanitizeUploadName(`${"a".repeat(300)}.pdf`);
      expect(out).toHaveLength(100);
      expect(out.endsWith(".pdf")).toBe(true);
    });

    it("does not let an absurdly long extension crowd out the name", () => {
      const out = sanitizeUploadName(`a.${"b".repeat(300)}`);
      expect(out).toHaveLength(100);
    });
  });

  describe("saveSessionFileUpload", () => {
    it("writes <cwd>/.mullion-uploads/<uuid>/<sanitized-name> and returns the path", () => {
      const filePath = saveSessionFileUpload(cwd, Buffer.from("hello"), "My Notes.txt");

      const uploadDir = path.join(path.resolve(cwd), UPLOAD_SUBDIR);
      expect(path.dirname(path.dirname(filePath))).toBe(uploadDir);
      expect(path.basename(filePath)).toBe("My_Notes.txt");
      expect(readFileSync(filePath, "utf8")).toBe("hello");
      expect(readFileSync(path.join(uploadDir, ".gitignore"), "utf8")).toBe("*\n");
    });

    it("keeps same-named uploads apart via the uuid directory", () => {
      const first = saveSessionFileUpload(cwd, Buffer.from("a"), "x.txt");
      const second = saveSessionFileUpload(cwd, Buffer.from("b"), "x.txt");

      expect(first).not.toBe(second);
      expect(readFileSync(first, "utf8")).toBe("a");
      expect(readFileSync(second, "utf8")).toBe("b");
    });

    it("cannot escape the upload directory through the file name", () => {
      const filePath = saveSessionFileUpload(cwd, Buffer.from("x"), "../../../evil.sh");

      expect(filePath.startsWith(path.join(path.resolve(cwd), UPLOAD_SUBDIR) + path.sep)).toBe(
        true,
      );
      expect(path.basename(filePath)).toBe("evil.sh");
    });

    it("refuses a symlinked .mullion-uploads like the image path does", () => {
      const target = mkdtempSync(path.join(os.tmpdir(), "mullion-upload-target-"));
      try {
        symlinkSync(target, path.join(cwd, UPLOAD_SUBDIR));
        expect(() => saveSessionFileUpload(cwd, Buffer.from("x"), "a.txt")).toThrow(
          /not a regular/,
        );
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });
  });

  it("exports a sane MAX_UPLOAD_BYTES ceiling", () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024);
  });

  describe("upload dir hardening", () => {
    it("refuses a symlinked .mullion-uploads without writing through it", () => {
      const target = mkdtempSync(path.join(os.tmpdir(), "mullion-upload-target-"));
      try {
        symlinkSync(target, path.join(cwd, UPLOAD_SUBDIR));
        expect(() => saveSessionUpload(cwd, PNG_BYTES, "image/png")).toThrow(/not a regular/);
        expect(existsSync(path.join(target, ".gitignore"))).toBe(false);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });

    it("refuses a plain file at .mullion-uploads with a 409-tagged error", () => {
      writeFileSync(path.join(cwd, UPLOAD_SUBDIR), "x");
      try {
        saveSessionUpload(cwd, PNG_BYTES, "image/png");
        expect.unreachable();
      } catch (err) {
        expect((err as { statusCode?: number }).statusCode).toBe(409);
      }
    });

    it("reuses an existing real directory without recreating .gitignore", () => {
      mkdirSync(path.join(cwd, UPLOAD_SUBDIR));
      const p = saveSessionUpload(cwd, PNG_BYTES, "image/png");
      expect(existsSync(p)).toBe(true);
      expect(existsSync(path.join(cwd, UPLOAD_SUBDIR, ".gitignore"))).toBe(false);
    });
  });

  describe("pruneUploadDir (issue #1637)", () => {
    const DAY = 86_400_000;
    function age(p: string, days: number) {
      const t = new Date(Date.now() - days * DAY);
      utimesSync(p, t, t);
    }

    it("removes stale image files and generic-file directories, keeps fresh ones and .gitignore", () => {
      const oldImg = saveSessionUpload(cwd, PNG_BYTES, "image/png");
      const oldFile = saveSessionFileUpload(cwd, Buffer.from("a"), "a.txt");
      const freshFile = saveSessionFileUpload(cwd, Buffer.from("b"), "b.txt");
      age(oldImg, 10);
      age(path.dirname(oldFile), 10);

      pruneUploadDir(path.join(cwd, UPLOAD_SUBDIR), 7 * DAY);

      expect(existsSync(oldImg)).toBe(false);
      expect(existsSync(path.dirname(oldFile))).toBe(false);
      expect(existsSync(freshFile)).toBe(true);
      expect(existsSync(path.join(cwd, UPLOAD_SUBDIR, ".gitignore"))).toBe(true);
    });

    it("unlinks a symlinked child without following it", () => {
      saveSessionUpload(cwd, PNG_BYTES, "image/png");
      const outside = mkdtempSync(path.join(os.tmpdir(), "mullion-outside-"));
      writeFileSync(path.join(outside, "keep.txt"), "keep");
      const link = path.join(cwd, UPLOAD_SUBDIR, "link");
      symlinkSync(outside, link);
      const t = new Date(Date.now() - 10 * DAY);
      // lutimes: age the link itself, not its target.
      lutimesSync(link, t, t);

      pruneUploadDir(path.join(cwd, UPLOAD_SUBDIR), 7 * DAY);

      expect(existsSync(link)).toBe(false);
      expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
      rmSync(outside, { recursive: true, force: true });
    });

    it("does nothing when maxAgeMs is 0, and is throttled to once an hour per dir", () => {
      const f = saveSessionFileUpload(cwd, Buffer.from("a"), "a.txt");
      const dir = path.join(cwd, UPLOAD_SUBDIR);
      age(path.dirname(f), 10);

      pruneUploadDir(dir, 0);
      expect(existsSync(f)).toBe(true);

      const now = Date.now();
      pruneUploadDir(dir, 7 * DAY, now); // runs, removes
      expect(existsSync(f)).toBe(false);
      const g = saveSessionFileUpload(cwd, Buffer.from("b"), "b.txt");
      age(path.dirname(g), 10);
      pruneUploadDir(dir, 7 * DAY, now + 60_000); // throttled
      expect(existsSync(g)).toBe(true);
      pruneUploadDir(dir, 7 * DAY, now + 2 * 3_600_000); // an hour later
      expect(existsSync(g)).toBe(false);
    });

    it("tolerates a missing directory", () => {
      expect(() => pruneUploadDir(path.join(cwd, "nope"), DAY)).not.toThrow();
    });
  });
});
