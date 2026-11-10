// Closure body moved out of TerminalPane's mount effect (issue #2406).
// The effect calls this factory at the declaration site and binds the
// returned functions to the same local names. Construction, the WebGL
// atlas sequence, OSC 10/11/12 registration, and the cleanup list stayed
// in the effect. Shared mutable locals are the explicit MountBag, not refs.

import type { Dispatch, SetStateAction } from "react";
import { MAX_UPLOAD_BYTES } from "../../../src/shared/constants.js";
import { api, ApiError } from "../api/index.js";
import { quotePastedPath } from "./quote-paste-path.js";
import type { MountBag } from "./mountBag.js";

// The backend buffers each upload body in memory, so a multi-file drop is
// uploaded a few at a time rather than all at once.
const MAX_CONCURRENT_UPLOADS = 3;
// Per drop/selection. Concurrency alone doesn't bound the request count or the
// bytes written to the session cwd, and a huge burst can exhaust the app-wide
// rate-limit bucket (tripping the client's global 429 breaker for every other
// dashboard call). The remainder is reported in a toast, not silently dropped.
const MAX_FILES_PER_UPLOAD = 20;
// ...and in total bytes (each file is also capped server-side at 25 MiB).
const MAX_BYTES_PER_UPLOAD = 100 * 1024 * 1024;

export interface MountUploadsDeps {
  setUploadNotice: Dispatch<SetStateAction<string | null>>;
  setUploadState: Dispatch<SetStateAction<"idle" | "uploading" | "error">>;
  pasteToTerminal: (text: string) => void;
  props: { params: { sessionId: number } };
}

export function attachMountUploads(bag: MountBag, deps: MountUploadsDeps) {
  const { setUploadNotice, setUploadState, pasteToTerminal, props } = deps;

  // Issue #68: the CLI running in this PTY is a host process — it can't
  // read the browser's clipboard, and even if raw image bytes reached it
  // over the WS/PTY byte stream there's no terminal image protocol (Sixel/
  // Kitty/iTerm2) or renderer in this stack to make sense of them anyway.
  // The only thing that actually works is a file the CLI can open by path:
  // upload the image, write it under the session's own cwd (backend), then
  // inject that path into the terminal exactly like a text paste. A
  // trailing space keeps it from running straight into whatever the user
  // types next.
  //
  // Handles several files (a multi-file drop or picker selection): uploaded
  // a few at a time (the backend buffers each body in memory) and the paths
  // that made it are pasted together, in the order the files were given, as
  // one paste. One failed upload flags the error state but doesn't discard
  // the others' paths. A bare Blob (clipboard image) has no name, so it gets
  // one from its mime subtype to keep a usable extension.
  //
  // Batches can overlap (a second drop while the first is still going): the
  // indicator stays "uploading" until the last one settles, and a failure in
  // any of them is reported once they all have.
  let batchesInFlight = 0;
  let sawUploadFailure = false;
  //
  // `skippedEntries` is how many dropped folders/empty entries the caller
  // already filtered out; it is folded into the same single notice as the
  // limits applied here, since only one notice can render.
  function uploadAndInjectFiles(allFiles: Blob[], skippedEntries = 0): void {
    const files: Blob[] = [];
    let totalBytes = 0;
    let tooBig = 0;
    let overLimit = 0;
    for (const f of allFiles) {
      if (f.size > MAX_UPLOAD_BYTES) tooBig++;
      else if (files.length >= MAX_FILES_PER_UPLOAD || totalBytes + f.size > MAX_BYTES_PER_UPLOAD)
        overLimit++;
      else {
        files.push(f);
        totalBytes += f.size;
      }
    }
    const notes: string[] = [];
    if (skippedEntries > 0) notes.push(`${skippedEntries} folder(s)/empty file(s) skipped`);
    if (tooBig > 0) {
      notes.push(`${tooBig} file(s) over ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB skipped`);
    }
    if (overLimit > 0) notes.push(`${overLimit} file(s) over the per-drop limit skipped`);
    if (notes.length > 0) setUploadNotice(notes.join(", "));
    if (files.length === 0) return;
    batchesInFlight++;
    setUploadState("uploading");
    // async: a synchronous throw (e.g. encodeURIComponent on an unpaired
    // surrogate in a file name) must reject, not escape Promise.all's setup.
    const uploadOne = async (file: Blob) => {
      const name =
        file instanceof File
          ? file.name
          : `pasted.${file.type.split("/")[1]?.split("+")[0] || "bin"}`;
      try {
        return await api.uploadSessionFile(props.params.sessionId, file, name);
      } catch (err) {
        // The bytes didn't match the image type the browser claimed —
        // keep the file anyway, as a plain upload (once, no further retry).
        if (err instanceof ApiError && err.code === "UPLOAD_IMAGE_MISMATCH") {
          return api.uploadSessionFile(props.params.sessionId, file, name, { asGeneric: true });
        }
        throw err;
      }
    };
    const results: PromiseSettledResult<{ path: string }>[] = new Array(files.length);
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        results[i] = await uploadOne(files[i]!).then(
          (value): PromiseFulfilledResult<{ path: string }> => ({ status: "fulfilled", value }),
          (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
        );
      }
    };
    Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, files.length) }, worker),
    ).then(() => {
      if (bag.destroyed) return;
      const paths: string[] = [];
      let failed = false;
      for (const result of results) {
        if (result.status === "fulfilled") paths.push(result.value.path);
        else {
          failed = true;
          console.warn("[terminal] file upload failed:", result.reason);
          if (result.reason instanceof ApiError && result.reason.code === "UPLOAD_AGENT_OUTDATED") {
            setUploadNotice(result.reason.message);
          }
        }
      }
      if (paths.length > 0) pasteToTerminal(`${paths.map(quotePastedPath).join(" ")} `);
      sawUploadFailure ||= failed;
      if (--batchesInFlight === 0) {
        setUploadState(sawUploadFailure ? "error" : "idle");
        sawUploadFailure = false;
      }
    });
  }

  // Checks the clipboard for an image entry (a screenshot or copied photo,
  // as opposed to copied text) and, if found, routes it through the upload
  // path above instead of a text paste. navigator.clipboard.read() needs a
  // secure context/permission and is less broadly supported than
  // readText() — any failure here (denied, unavailable, no image type
  // present) resolves false so the caller falls through to the ordinary
  // text-paste path rather than surfacing an error for what is, from the
  // user's perspective, just a normal paste.
  async function tryImagePaste(): Promise<boolean> {
    if (!navigator.clipboard?.read) return false;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (!imageType) continue;
        uploadAndInjectFiles([await item.getType(imageType)]);
        return true;
      }
    } catch (err) {
      console.warn("[terminal] clipboard image read unavailable, falling back to text:", err);
    }
    return false;
  }

  return { uploadAndInjectFiles, tryImagePaste };
}
