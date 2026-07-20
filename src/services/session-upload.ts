import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Issue #68: a pasted/attached image can't travel down the terminal's own
// byte stream (no Sixel/Kitty/iTerm2 support, and the CLI running in the PTY
// couldn't read inline image bytes off stdin even if it could parse them
// anyway) — the only thing that actually gets an image "into" a CLI like
// Claude Code is a file it can open by path. This writes the upload into the
// session's own cwd so it's already inside the CLI's workspace (no
// out-of-workspace read prompt) and returns that path for the frontend to
// inject into the terminal, exactly like a text paste.

// The browser-supplied Content-Type alone only picks a filename extension —
// it's never trusted for anything else. matchesMagicBytes below is the
// actual content check: the caller-declared mime must additionally match the
// file's own leading signature bytes before anything is written, so a client
// can't smuggle arbitrary content onto disk (e.g. HTML/script) under a
// `.png`/`.jpg` extension by lying about Content-Type.
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

// One entry per MIME_EXTENSIONS key — each checks the buffer's own leading
// bytes against that format's real file signature, independent of whatever
// Content-Type the client claims.
const MAGIC_BYTE_CHECKS: Record<string, (buf: Buffer) => boolean> = {
  "image/png": (buf) =>
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a,
  "image/jpeg": (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  "image/gif": (buf) =>
    buf.length >= 6 &&
    buf.subarray(0, 3).toString("latin1") === "GIF" &&
    (buf.subarray(3, 6).toString("latin1") === "87a" ||
      buf.subarray(3, 6).toString("latin1") === "89a"),
  "image/webp": (buf) =>
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP",
};

/**
 * True only when `buffer` actually starts with `mime`'s real file signature
 * — the content check backing MIME_EXTENSIONS' doc comment above. `mime`
 * must already be one of MIME_EXTENSIONS' keys (callers check
 * extensionForMime first); an unrecognized mime here reads as a mismatch,
 * not a pass.
 */
export function matchesMagicBytes(buffer: Buffer, mime: string): boolean {
  return MAGIC_BYTE_CHECKS[mime]?.(buffer) ?? false;
}

// Generous enough for a screenshot or camera photo, small enough to keep a
// misbehaving/malicious client from parking an arbitrarily large body on
// disk — mirrors the spirit of websocket.ts's own maxPayload comment.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const UPLOAD_SUBDIR = ".tessera-uploads";

export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[mime] ?? null;
}

/**
 * Writes `buffer` into `<cwd>/.tessera-uploads/<random>.<ext>` and returns
 * the absolute path. `mime` must be one of MIME_EXTENSIONS' keys and match
 * `buffer`'s real signature (callers check extensionForMime/matchesMagicBytes
 * before this runs). The filename is always server-generated — never derived
 * from caller input — so there's nothing for a traversal attempt to reach
 * outside the fixed upload subdirectory.
 *
 * `cwd` itself is trusted at the same level as PtyManager's own spawn/attach
 * cwd (routes/internal.ts's own `/internal/sessions` and `/internal/ws/attach`
 * — see that file's doc comments): for the primary's local route it's a
 * DB-persisted project/session cwd, and for the agent role it's a caller-
 * supplied path gated only by the shared TESSERA_AGENT_TOKEN, not scoped to
 * PROJECTS_ROOTS. This is deliberate, not an oversight — whoever holds that
 * token (or reaches the primary's own routes) can already spawn an arbitrary
 * program in this same cwd via those sibling endpoints, which subsumes
 * "write a file here"; restricting cwd only for uploads wouldn't remove any
 * real capability, just make this one endpoint inconsistent with its
 * siblings. What IS enforced regardless of cwd: a hard size cap
 * (MAX_UPLOAD_BYTES, plus the route's own bodyLimit), an image-only mime
 * allow-list verified against the file's actual bytes (not just a claimed
 * Content-Type), and a server-generated filename confined to the fixed
 * `.tessera-uploads/` subdirectory.
 */
export function saveSessionUpload(cwd: string, buffer: Buffer, mime: string): string {
  const ext = extensionForMime(mime);
  if (!ext) throw new Error(`Unsupported image type: ${mime}`);

  const uploadDir = path.join(path.resolve(cwd), UPLOAD_SUBDIR);
  const isNewDir = !existsSync(uploadDir);
  mkdirSync(uploadDir, { recursive: true });
  if (isNewDir) {
    // Keeps a project's own git status clean of pasted-image litter — an
    // upload is transient input to the CLI, not a file the user meant to add
    // to their repo.
    writeFileSync(path.join(uploadDir, ".gitignore"), "*\n");
  }

  const filename = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(uploadDir, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}
