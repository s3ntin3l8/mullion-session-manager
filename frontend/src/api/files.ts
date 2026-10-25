// FileEditorPanel.tsx's backend surface: list a project directory, read one
// text file, write one text file (routes/project-files.ts). Paths are always
// project-relative; the backend contains them to the project root.
import {
  ApiError,
  DEFAULT_RETRY_AFTER_MS,
  RateLimitedError,
  parseRetryAfterMs,
  request,
} from "./client.js";
import type {
  ProjectDirListing,
  ProjectFileContent,
  ProjectFileWriteResult,
  ProjectSearchListing,
} from "./types.js";

function sessionQuery(sessionId: number | undefined): string {
  return sessionId === undefined ? "" : `&sessionId=${sessionId}`;
}

export const filesApi = {
  // Every call takes an optional trailing `sessionId`: the editor is then
  // rooted at that session's cwd (a worktree session's own checkout) instead
  // of the project's.
  listProjectFiles: (projectId: number, dirPath = "", sessionId?: number) =>
    request<ProjectDirListing>(
      `/api/projects/${projectId}/files?path=${encodeURIComponent(dirPath)}${sessionQuery(sessionId)}`,
    ),

  readProjectFile: (projectId: number, filePath: string, sessionId?: number) =>
    request<ProjectFileContent>(
      `/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}${sessionQuery(sessionId)}`,
    ),

  // Read-only: a file outside the project under one of Settings'
  // "Readable paths" (an agent's plan, ...). `absPath` is absolute or `~/`;
  // 403 code "not_allowlisted" when it isn't under an allowed folder.
  readExternalFile: (projectId: number, absPath: string) =>
    request<ProjectFileContent>(
      `/api/projects/${projectId}/external-file?path=${encodeURIComponent(absPath)}`,
    ),

  // `expectedMtimeMs` makes the write fail with 409 (code "conflict") if the
  // file changed on disk since it was loaded; `create` makes it fail with
  // 409 if the file already exists, and is the only way to create one.
  writeProjectFile: (
    projectId: number,
    filePath: string,
    content: string,
    opts: { expectedMtimeMs?: number; create?: boolean } = {},
    sessionId?: number,
  ) =>
    request<ProjectFileWriteResult>(`/api/projects/${projectId}/file`, {
      method: "PUT",
      body: JSON.stringify({ path: filePath, content, ...opts, sessionId }),
    }),

  // Creates one folder; the parent must exist. 409 if the path is taken.
  mkdirProjectDir: (projectId: number, dirPath: string, sessionId?: number) =>
    request<{ path: string }>(`/api/projects/${projectId}/files/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path: dirPath, sessionId }),
    }),

  // Renames/moves within the project; 409 if the destination exists.
  renameProjectPath: (projectId: number, from: string, to: string, sessionId?: number) =>
    request<{ path: string }>(`/api/projects/${projectId}/files/rename`, {
      method: "POST",
      body: JSON.stringify({ from, to, sessionId }),
    }),

  // Deletes a file, a symlink (the link itself), or an EMPTY folder (409
  // code "not_empty" otherwise).
  deleteProjectPath: (projectId: number, entryPath: string, sessionId?: number) =>
    request<{ path: string }>(
      `/api/projects/${projectId}/file?path=${encodeURIComponent(entryPath)}${sessionQuery(sessionId)}`,
      { method: "DELETE" },
    ),

  // Fuzzy filename search (dotfiles included; .git / node_modules skipped).
  searchProjectFiles: (projectId: number, query: string, sessionId?: number) =>
    request<ProjectSearchListing>(
      `/api/projects/${projectId}/files/search?q=${encodeURIComponent(query)}${sessionQuery(sessionId)}`,
    ),

  // The browser's own download manager streams this to disk — the session
  // cookie rides along on a plain same-origin navigation, so no blob is built
  // in memory, whatever the file size.
  projectFileDownloadUrl: (projectId: number, filePath: string, sessionId?: number) =>
    `/api/projects/${projectId}/files/download?path=${encodeURIComponent(filePath)}${sessionQuery(sessionId)}`,

  // Raw bytes into memory — for previews of small files (an image), never for
  // a download.
  fetchProjectFileBlob: async (
    projectId: number,
    filePath: string,
    opts: { sessionId?: number; type?: string; signal?: AbortSignal; maxBytes?: number } = {},
  ): Promise<Blob> => {
    const res = await fetch(filesApi.projectFileDownloadUrl(projectId, filePath, opts.sessionId), {
      credentials: "same-origin",
      signal: opts.signal,
    });
    if (!res.ok) throw await apiErrorFromResponse(res.status, await res.text().catch(() => ""));
    const blob = await readCapped(res, opts.maxBytes);
    // The server serves everything as an opaque attachment; the caller picks
    // the type it is willing to render.
    return opts.type ? blob.slice(0, blob.size, opts.type) : blob;
  },

  // Streams one file into a NEW project path (409 code "conflict" if it
  // exists — never overwrites). XHR rather than fetch because only XHR reports
  // upload progress; the File is the request body, so the browser streams it
  // from disk. `mkdirs` creates missing parent folders (folder upload).
  uploadProjectFile: (
    projectId: number,
    filePath: string,
    file: File,
    opts: {
      sessionId?: number;
      mkdirs?: boolean;
      onProgress?: (loaded: number, total: number) => void;
      signal?: AbortSignal;
    } = {},
  ) =>
    new Promise<{ path: string; size: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const mkdirs = opts.mkdirs ? "&mkdirs=1" : "";
      xhr.open(
        "POST",
        `/api/projects/${projectId}/files/upload?path=${encodeURIComponent(filePath)}${mkdirs}${sessionQuery(opts.sessionId)}`,
      );
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as { path: string; size: number });
          } catch {
            reject(new ApiError("Unexpected response from the server", xhr.status));
          }
          return;
        }
        if (xhr.status === 429) {
          // Not a failure to report: the caller waits this long and retries.
          const retryAfterMs = parseRetryAfterMs(
            xhr.getResponseHeader("retry-after"),
            DEFAULT_RETRY_AFTER_MS,
          );
          reject(new RateLimitedError(429, retryAfterMs));
          return;
        }
        void apiErrorFromResponse(xhr.status, xhr.responseText).then(reject);
      };
      xhr.onerror = () => reject(new ApiError("Network error during upload", 0));
      xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(new DOMException("Upload cancelled", "AbortError"));
          return;
        }
        opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      xhr.send(file);
    }),
};

async function apiErrorFromResponse(status: number, bodyText: string): Promise<ApiError> {
  let message = `Request failed (HTTP ${status})`;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { message?: unknown; code?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
    if (typeof parsed.code === "string") code = parsed.code;
  } catch {
    // non-JSON body (a gateway page, ...) — keep the generic message
  }
  return new ApiError(message, status, code);
}

// Reads a response body into a Blob, refusing — as soon as the count says so,
// not after the whole thing is in memory — once it passes `maxBytes`. Counted
// while reading rather than trusting Content-Length, which a response may omit
// (or lie about).
async function readCapped(res: Response, maxBytes: number | undefined): Promise<Blob> {
  const tooLarge = () => new ApiError("Too large to preview", 413, "too_large");
  if (maxBytes === undefined || !res.body) return res.blob();
  const declared = res.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value as Uint8Array<ArrayBuffer>);
  }
  return new Blob(chunks, { type: res.headers.get("content-type") ?? "" });
}
