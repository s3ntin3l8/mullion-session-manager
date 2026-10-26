import { useEffect, useState } from "react";
import { api, ApiError } from "../api/index.js";
import { imageMimeFor, MAX_IMAGE_PREVIEW_BYTES } from "../lib/imagePreview.js";
import { DownloadIcon, FileTextIcon } from "../ui/icons.js";
import { EmptyStateNote } from "../ui/EmptyState.js";

export type NonTextReason = "binary" | "too_large";

// What the file browser shows for a file the text editor can't open: an inline
// preview for an image, otherwise a note — and a Download either way.
export function NonTextFileView({
  projectId,
  sessionId,
  path,
  reason,
}: {
  projectId: number;
  sessionId?: number;
  path: string;
  reason: NonTextReason;
}) {
  const mime = imageMimeFor(path);
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const [previewError, setPreviewError] = useState<{ path: string; message: string } | null>(null);

  useEffect(() => {
    if (!mime) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    api
      .fetchProjectFileBlob(projectId, path, {
        sessionId,
        type: mime,
        signal: controller.signal,
        maxBytes: MAX_IMAGE_PREVIEW_BYTES,
      })
      .then((blob) => {
        // Resolved while the effect was being torn down: its cleanup has
        // already run, so a URL made now would never be revoked.
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ path, url: objectUrl });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setPreviewError({
          path,
          message:
            err instanceof ApiError && err.code === "too_large"
              ? "Too large to preview — download it instead."
              : "Couldn't load a preview.",
        });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, sessionId, path, mime]);

  // Keyed on the path so a stale result for the previously opened file never
  // shows under the new one's header.
  const shown = preview?.path === path ? preview.url : null;
  const failed = previewError?.path === path ? previewError.message : null;
  const note =
    reason === "too_large"
      ? "Over the 1 MiB edit limit — too large to edit here."
      : "Not a UTF-8 text file — it can't be edited here.";

  return (
    <>
      <div className="agent-rules-panel-editor-header">
        <div className="agent-rules-panel-editor-title">
          <FileTextIcon size={14} />
          {path}
        </div>
        <div className="agent-rules-panel-editor-actions">
          <a
            className="file-editor-icon-btn"
            href={api.projectFileDownloadUrl(projectId, path, sessionId)}
            download
            aria-label="Download file"
            title="Download"
          >
            <DownloadIcon size={15} />
          </a>
        </div>
      </div>
      {mime && shown ? (
        <div className="file-editor-image-preview">
          <img src={shown} alt={path} />
        </div>
      ) : (
        <EmptyStateNote>
          <FileTextIcon size={20} />
          <div>{mime && !failed ? "Loading preview…" : (failed ?? note)}</div>
          {failed && <div className="agent-rules-panel-row-meta">{note}</div>}
        </EmptyStateNote>
      )}
    </>
  );
}
