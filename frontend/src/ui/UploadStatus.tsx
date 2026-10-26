import type { UploadProgress } from "../hooks/useProjectUploads.js";
import { CloseIcon } from "./icons.js";

const MAX_LISTED_ERRORS = 5;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// The progress row + error list for useProjectUploads: shown in the file trees
// while a batch is uploading and until its failures are dismissed.
export function UploadStatus({
  progress,
  errors,
  onCancel,
  onDismiss,
}: {
  progress: UploadProgress | null;
  errors: string[];
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (!progress && errors.length === 0) return null;
  const pct =
    progress && progress.bytes > 0 ? Math.min(100, (progress.bytesDone / progress.bytes) * 100) : 0;
  return (
    <div className="upload-status" role="status" aria-live="polite">
      {progress && (
        <div className="upload-status-row">
          <div className="upload-status-text">
            <span>
              Uploading {Math.min(progress.filesDone + 1, progress.files)}/{progress.files}
              {" · "}
              {formatBytes(progress.bytesDone)} of {formatBytes(progress.bytes)}
            </span>
            {progress.current && <span className="upload-status-current">{progress.current}</span>}
            <div
              className="upload-status-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
            >
              <div className="upload-status-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <button
            type="button"
            className="file-editor-icon-btn"
            aria-label="Cancel upload"
            title="Cancel upload"
            onClick={onCancel}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      )}
      {errors.length > 0 && (
        <div className="upload-status-errors">
          <ul>
            {errors.slice(0, MAX_LISTED_ERRORS).map((message) => (
              <li key={message}>{message}</li>
            ))}
            {errors.length > MAX_LISTED_ERRORS && (
              <li>…and {errors.length - MAX_LISTED_ERRORS} more</li>
            )}
          </ul>
          <button
            type="button"
            className="file-editor-icon-btn"
            aria-label="Dismiss upload errors"
            title="Dismiss"
            onClick={onDismiss}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
