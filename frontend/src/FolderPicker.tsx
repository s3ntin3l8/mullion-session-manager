import { useEffect, useRef, useState } from "react";
import { api } from "./api/index.js";
import type { DirectoryListing } from "./api/fs.js";

/** Browses a host's filesystem (the primary's unless `hostId` names a remote
 * host), never the browser's machine. */
export function FolderPicker({
  initialPath,
  hostId,
  onSelect,
  onClose,
}: {
  initialPath: string;
  hostId?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const focusAfterNavigation = useRef(false);
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listDirectories(path, { hidden: showHidden, hostId }).then(
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
  }, [path, showHidden, hostId]);

  useEffect(() => {
    if (!listing || !focusAfterNavigation.current) return;
    focusAfterNavigation.current = false;
    // Leave focus alone if the user moved elsewhere while the listing loaded.
    if (document.activeElement === closeRef.current) {
      (listRef.current?.querySelector("button") ?? selectRef.current)?.focus();
    }
  }, [listing]);

  const navigate = (next: string) => {
    focusAfterNavigation.current = true;
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
      <label className="create-modal-field-hint">
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(event) => {
            setListing(null);
            setError(null);
            setShowHidden(event.target.checked);
          }}
        />{" "}
        Show hidden folders
      </label>
      {error ? (
        <p className="create-modal-field-hint error" role="alert">
          {error}
        </p>
      ) : !listing ? (
        <p role="status">Loading folders…</p>
      ) : (
        <>
          <ul ref={listRef} className="folder-picker-list" aria-label="Folders">
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
            ref={selectRef}
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

export function BrowseButton({ remote, onClick }: { remote: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="create-modal-browse-btn"
      onClick={onClick}
      title={remote ? "Browse folders on the selected host" : "Browse folders on this machine"}
    >
      Browse…
    </button>
  );
}
