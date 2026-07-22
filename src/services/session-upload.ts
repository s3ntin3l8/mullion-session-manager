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

/**
 * True only when `buffer` actually starts with `mime`'s real file signature
 * — the content check backing MIME_EXTENSIONS' doc comment above. `mime`
 * must already be one of MIME_EXTENSIONS' keys (callers check
 * extensionForMime first); an unrecognized mime here reads as a mismatch,
 * not a pass.
 *
 * A literal `switch` on purpose, not a `Record<string, (buf) => boolean>`
 * keyed and invoked by `mime` — CodeQL flagged that shape as an
 * "unvalidated dynamic method call" (dispatch on a user-controlled name),
 * even though the only thing at stake was `?.()` on an unknown key. A
 * `switch` over literal cases has no dynamic dispatch for CodeQL to flag.
 */
export function matchesMagicBytes(buffer: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/png":
      return (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );
    case "image/jpeg":
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/gif":
      return (
        buffer.length >= 6 &&
        buffer.subarray(0, 3).toString("latin1") === "GIF" &&
        (buffer.subarray(3, 6).toString("latin1") === "87a" ||
          buffer.subarray(3, 6).toString("latin1") === "89a")
      );
    case "image/webp":
      return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
        buffer.subarray(8, 12).toString("latin1") === "WEBP"
      );
    default:
      return false;
  }
}

// Generous enough for a screenshot or camera photo, small enough to keep a
// misbehaving/malicious client from parking an arbitrarily large body on
// disk — mirrors the spirit of websocket.ts's own maxPayload comment.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const UPLOAD_SUBDIR = ".mullion-uploads";

export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[mime] ?? null;
}

/**
 * Writes `buffer` into `<cwd>/.mullion-uploads/<random>.<ext>` and returns
 * the absolute path. `mime` must be one of MIME_EXTENSIONS' keys and match
 * `buffer`'s real signature (callers check extensionForMime/matchesMagicBytes
 * before this runs). The filename is always server-generated — never derived
 * from caller input — so there's nothing for a traversal attempt to reach
 * outside the fixed upload subdirectory.
 *
 * `cwd` trust is caller-dependent, not this function's concern: the
 * primary's local route (routes/sessions.ts) passes a DB-persisted
 * project/session cwd, trusted at the same level as its own unrestricted
 * project-cwd model. The agent route (`POST /internal/uploads`,
 * routes/internal.ts) resolves and confines `cwd` to this host's own
 * PROJECTS_ROOTS via `resolveWithinRoots` *before* calling this function —
 * the same barrier `/internal/actions`, `/internal/dock`, and
 * `/internal/github-repo` already apply to a caller-supplied cwd (see that
 * function's doc comment). CodeQL flagged this route's original
 * unrestricted cwd as uncontrolled data reaching a real filesystem write —
 * unlike those read-only routes, and unlike `/internal/sessions`/
 * `/internal/ws/attach`'s exec-only use of cwd, `saveSessionUpload` actually
 * creates a directory and writes a file, so it needed the same containment
 * those read routes already had. What this function itself enforces
 * regardless of caller: a hard size cap (MAX_UPLOAD_BYTES, plus the route's
 * own bodyLimit), an image-only mime allow-list verified against the file's
 * actual bytes (not just a claimed Content-Type), and a server-generated
 * filename confined to the fixed `.mullion-uploads/` subdirectory.
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
