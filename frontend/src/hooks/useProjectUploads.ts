import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, RateLimitedError } from "../api/index.js";
import type { UploadItem } from "../lib/dropped-files.js";

// A few files in flight at once: enough to keep a link busy with small files,
// few enough that a folder of thousands doesn't open thousands of sockets.
const MAX_CONCURRENT_UPLOADS = 3;

export interface UploadProgress {
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  /** Relative path of the file most recently started. */
  current: string | null;
}

function joinPath(dir: string, rel: string): string {
  return dir === "" ? rel : `${dir}/${rel}`;
}

// A throttled upload waits out Retry-After and tries again — a big folder drop
// outruns a modest app-wide limit, and that should slow it down, not fail it.
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_MS = 65_000;

// Resolves after `ms`, or as soon as `signal` aborts.
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function describeFailure(relativePath: string, err: unknown): string {
  if (err instanceof RateLimitedError) {
    return `${relativePath}: the server is rate-limiting uploads — try again in a minute`;
  }
  if (err instanceof ApiError) {
    if (err.code === "conflict") return `${relativePath} already exists`;
    if (err.code === "too_large") return `${relativePath} is too large`;
    return `${relativePath}: ${err.message}`;
  }
  return `${relativePath}: upload failed`;
}

// Uploads files into a project folder (optionally inside a session's checkout),
// reporting progress and per-file errors. A name that already exists is
// refused by the server (never overwritten) and shows up as an error here.
export function useProjectUploads(opts: {
  projectId: number;
  sessionId?: number;
  /** Fired once a batch has finished (even partly), with the folder it went to. */
  onUploaded?: (targetDir: string) => void;
  /** A hint that `path` (project-relative) is already taken, from a listing the
   * caller already has: such a file is refused without sending its bytes. The
   * server stays the authority — a stale hint only costs a skipped upload. */
  existsHint?: (path: string) => boolean;
}) {
  const { projectId, sessionId } = opts;
  const onUploadedRef = useRef(opts.onUploaded);
  const existsHintRef = useRef(opts.existsHint);
  useEffect(() => {
    onUploadedRef.current = opts.onUploaded;
    existsHintRef.current = opts.existsHint;
  });
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const upload = useCallback(
    async (items: UploadItem[], targetDir: string) => {
      if (items.length === 0) return;
      if (controllerRef.current) {
        setErrors(["An upload is already running — wait for it to finish, or cancel it"]);
        return;
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      const loaded = new Array<number>(items.length).fill(0);
      const bytes = items.reduce((n, i) => n + i.file.size, 0);
      let filesDone = 0;
      let current: string | null = null;
      const failures: string[] = [];
      const publish = () => {
        if (!alive.current) return;
        setProgress({
          files: items.length,
          filesDone,
          bytes,
          bytesDone: loaded.reduce((a, b) => a + b, 0),
          current,
        });
      };
      if (alive.current) setErrors([]);
      publish();
      let next = 0;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = next++;
          const item = items[index];
          if (!item) return;
          current = item.relativePath;
          publish();
          const target = joinPath(targetDir, item.relativePath);
          if (existsHintRef.current?.(target)) {
            // Taken already: don't push a (possibly huge) body to learn that.
            failures.push(`${item.relativePath} already exists`);
            loaded[index] = item.file.size;
            filesDone++;
            publish();
            continue;
          }
          try {
            for (let attempt = 0; ; attempt++) {
              try {
                await api.uploadProjectFile(projectId, target, item.file, {
                  sessionId,
                  mkdirs: item.relativePath.includes("/"),
                  signal: controller.signal,
                  onProgress: (done) => {
                    loaded[index] = done;
                    publish();
                  },
                });
                loaded[index] = item.file.size;
                break;
              } catch (err) {
                if (!(err instanceof RateLimitedError) || attempt >= MAX_RATE_LIMIT_RETRIES) {
                  throw err;
                }
                loaded[index] = 0;
                publish();
                await waitOrAbort(
                  Math.min(err.retryAfterMs, MAX_RATE_LIMIT_WAIT_MS),
                  controller.signal,
                );
                if (controller.signal.aborted) return;
              }
            }
          } catch (err) {
            if (controller.signal.aborted) return;
            failures.push(describeFailure(item.relativePath, err));
          }
          filesDone++;
          publish();
        }
      };
      try {
        await Promise.all(
          Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, items.length) }, worker),
        );
      } finally {
        controllerRef.current = null;
        if (alive.current) {
          setProgress(null);
          if (failures.length > 0) setErrors(failures);
          // Not after the host component is gone: re-listing then is wasted
          // (and, for a tree that was re-targeted, aimed at the wrong place).
          onUploadedRef.current?.(targetDir);
        }
      }
    },
    [projectId, sessionId],
  );

  const cancel = useCallback(() => controllerRef.current?.abort(), []);
  const dismissErrors = useCallback(() => setErrors([]), []);
  return { upload, progress, errors, cancel, dismissErrors, busy: progress !== null };
}
