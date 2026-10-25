import { useEffect, useState } from "react";
import { api } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { CloseIcon } from "./ui/icons.js";
import { Modal } from "./ui/Modal.js";

interface SavedUrlModalProps {
  projectId: number;
  projectName: string;
  onClose: () => void;
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function SavedUrlModal({ projectId, projectName, onClose }: SavedUrlModalProps) {
  const { projectUrls, refreshProjectUrls, addProjectUrl, updateProjectUrl, deleteProjectUrl } =
    useDashboardStore();
  const urls = projectUrls[projectId] ?? [];

  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshProjectUrls(projectId);
  }, [projectId, refreshProjectUrls]);

  const handleAdd = async () => {
    if (!newLabel.trim() || !newUrl.trim()) return;
    if (!isValidUrl(newUrl.trim())) return;
    setError(null);
    try {
      await addProjectUrl(projectId, newLabel.trim(), newUrl.trim());
      setNewLabel("");
      setNewUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add URL.");
    }
  };

  const handleUpdate = async (urlId: number) => {
    if (!editLabel.trim() || !editUrl.trim()) return;
    if (!isValidUrl(editUrl.trim())) return;
    setError(null);
    try {
      await updateProjectUrl(projectId, urlId, { label: editLabel.trim(), url: editUrl.trim() });
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update URL.");
    }
  };

  const toggleFavorite = async (urlId: number, current: boolean) => {
    try {
      await updateProjectUrl(projectId, urlId, { favorite: !current });
    } catch {
      void refreshProjectUrls(projectId);
    }
  };

  const handleDelete = async (urlId: number) => {
    try {
      await deleteProjectUrl(projectId, urlId);
    } catch {
      void refreshProjectUrls(projectId);
    }
  };

  const moveItem = async (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= urls.length) return;
    const ids = urls.map((u) => u.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(newIndex, 0, moved);
    useDashboardStore.setState((state) => {
      const updated = [...urls];
      const [item] = updated.splice(index, 1);
      updated.splice(newIndex, 0, item);
      return {
        projectUrls: { ...state.projectUrls, [projectId]: updated },
      };
    });
    try {
      await api.reorderProjectUrls(projectId, ids);
    } catch {
      void refreshProjectUrls(projectId);
    }
  };

  const addDisabled = !newLabel.trim() || !newUrl.trim() || !isValidUrl(newUrl.trim());

  return (
    <Modal
      onClose={onClose}
      backdropClassName="overlay-backdrop"
      modalClassName="saved-url-modal"
      headerClassName="saved-url-modal-header"
      bodyClassName="saved-url-modal-body"
      ariaLabel={`Saved URLs — ${projectName}`}
      title={`Saved URLs — ${projectName}`}
      // This dialog has its own header (an <h2>, not the create-modal icon
      // + title pair), so it supplies the header markup itself — including
      // the close button, which carries its own accessible name.
      headerContent={
        <>
          <h2>Saved URLs — {projectName}</h2>
          <button className="saved-url-modal-close" onClick={onClose} aria-label="Close dialog">
            <CloseIcon size={14} />
          </button>
        </>
      }
    >
      <div className="saved-url-form">
        <input
          className="saved-url-input mono"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label (e.g. Production)"
          aria-label="Label for the new URL"
        />
        <input
          className="saved-url-input mono"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="https://example.com"
          aria-label="URL to save"
        />
        <button className="saved-url-add-btn" onClick={handleAdd} disabled={addDisabled}>
          Add
        </button>
      </div>

      {error && <div className="saved-url-error">{error}</div>}
      <div className="saved-url-list">
        {urls.length === 0 && (
          <div className="saved-url-empty">No saved URLs yet. Add one above.</div>
        )}
        {urls.map((u, i) => (
          <div key={u.id} className="saved-url-row">
            <div className="saved-url-row-order">
              <button
                className="saved-url-order-btn"
                disabled={i === 0}
                onClick={() => moveItem(i, "up")}
                title="Move up"
                aria-label={`Move ${u.label} up`}
              >
                ▲
              </button>
              <button
                className="saved-url-order-btn"
                disabled={i === urls.length - 1}
                onClick={() => moveItem(i, "down")}
                title="Move down"
                aria-label={`Move ${u.label} down`}
              >
                ▼
              </button>
            </div>
            {editingId === u.id ? (
              <div className="saved-url-edit-fields">
                <input
                  className="saved-url-input mono"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  aria-label={`Label for ${u.label}`}
                />
                <input
                  className="saved-url-input mono"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  aria-label={`URL for ${u.label}`}
                />
                <button
                  className="saved-url-add-btn"
                  disabled={!editLabel.trim() || !editUrl.trim() || !isValidUrl(editUrl.trim())}
                  onClick={() => handleUpdate(u.id)}
                >
                  Save
                </button>
                <button className="saved-url-cancel-btn" onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  className={`saved-url-fav-btn${u.favorite ? " favorited" : ""}`}
                  onClick={() => toggleFavorite(u.id, u.favorite)}
                  title={u.favorite ? "Remove from favorites" : "Add to favorites"}
                  aria-label={
                    u.favorite ? `Remove ${u.label} from favorites` : `Add ${u.label} to favorites`
                  }
                  aria-pressed={u.favorite}
                >
                  {u.favorite ? "★" : "☆"}
                </button>
                <div className="saved-url-info">
                  <span className="saved-url-label">{u.label}</span>
                  <span className="saved-url-value mono">{u.url}</span>
                </div>
                <button
                  className="saved-url-edit-btn"
                  onClick={() => {
                    setEditingId(u.id);
                    setEditLabel(u.label);
                    setEditUrl(u.url);
                  }}
                  title="Edit"
                  aria-label={`Edit ${u.label}`}
                >
                  ✎
                </button>
                <button
                  className="saved-url-del-btn"
                  onClick={() => handleDelete(u.id)}
                  title="Delete"
                  aria-label={`Delete ${u.label}`}
                >
                  <CloseIcon size={12} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
