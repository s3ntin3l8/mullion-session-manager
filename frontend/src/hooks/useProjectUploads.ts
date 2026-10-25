import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/index.js";
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

function describeFailure(relativePath: string, err: unknown): string {
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
}) {
  const { projectId, sessionId } = opts;
  const onUploadedRef = useRef(opts.onUploaded);
  useEffect(() => {
    onUploadedRef.current = opts.onUploaded;
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
          try {
            await api.uploadProjectFile(
              projectId,
              joinPath(targetDir, item.relativePath),
              item.file,
              {
                sessionId,
                mkdirs: item.relativePath.includes("/"),
                signal: controller.signal,
                onProgress: (done) => {
                  loaded[index] = done;
                  publish();
                },
              },
            );
            loaded[index] = item.file.size;
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
        }
        onUploadedRef.current?.(targetDir);
      }
    },
    [projectId, sessionId],
  );

  const cancel = useCallback(() => controllerRef.current?.abort(), []);
  const dismissErrors = useCallback(() => setErrors([]), []);
  return { upload, progress, errors, cancel, dismissErrors, busy: progress !== null };
}
