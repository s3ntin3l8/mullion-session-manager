import { useEffect, useRef, useState } from "react";
import { api } from "./api/index.js";
import type { DirectoryListing } from "./api/fs.js";

/** Browses the server's filesystem, never the browser's machine. */
export function FolderPicker({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listDirectories(path).then(
      (result) => {
        if (!cancelled) setListing(result);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not list folders.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  const navigate = (next: string) => {
    closeRef.current?.focus();
    setListing(null);
    setError(null);
    setPath(next);
  };

  return (
    <section className="folder-picker" aria-label="Choose repository folder">
      <div className="folder-picker-heading">
        <span className="mono">{listing?.path ?? path}</span>
        <button ref={closeRef} type="button" className="create-modal-browse-btn" onClick={onClose}>
          Close picker
        </button>
      </div>
      {error ? (
        <p className="create-modal-field-hint error" role="alert">
          {error}
        </p>
      ) : !listing ? (
        <p role="status">Loading folders…</p>
      ) : (
        <>
          <ul className="folder-picker-list" aria-label="Folders">
            {listing.parent && (
              <li>
                <button type="button" onClick={() => navigate(listing.parent!)}>
                  ↑ Up one folder
                </button>
              </li>
            )}
            {listing.directories.map((directory) => (
              <li key={directory.path}>
                <button type="button" onClick={() => navigate(directory.path)}>
                  {directory.name}/
                </button>
              </li>
            ))}
          </ul>
          {listing.directories.length === 0 && (
            <p className="create-modal-field-hint">No subfolders.</p>
          )}
          {listing.truncated && (
            <p className="create-modal-field-hint">
              This folder is too large to show every entry. Enter a more specific repository path to
              browse further.
            </p>
          )}
          <button
            type="button"
            className="create-modal-dir-confirm-btn"
            onClick={() => onSelect(listing.path)}
          >
            Select this folder
          </button>
        </>
      )}
    </section>
  );
}
