import { useEffect, useState } from "react";
import { useDashboardStore } from "./store.js";
import { CloseIcon } from "./icons.js";

interface SavedUrlModalProps {
  projectId: number;
  projectName: string;
  onClose: () => void;
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

  useEffect(() => {
    void refreshProjectUrls(projectId);
  }, [projectId, refreshProjectUrls]);

  const handleAdd = async () => {
    if (!newLabel.trim() || !newUrl.trim()) return;
    try {
      await addProjectUrl(projectId, newLabel.trim(), newUrl.trim());
      setNewLabel("");
      setNewUrl("");
    } catch {
      // handled by store
    }
  };

  const handleUpdate = async (urlId: number) => {
    if (!editLabel.trim() || !editUrl.trim()) return;
    await updateProjectUrl(projectId, urlId, { label: editLabel.trim(), url: editUrl.trim() });
    setEditingId(null);
  };

  const toggleFavorite = (urlId: number, current: boolean) => {
    void updateProjectUrl(projectId, urlId, { favorite: !current });
  };

  const handleDelete = (urlId: number) => {
    void deleteProjectUrl(projectId, urlId);
  };

  const moveItem = (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= urls.length) return;
    const ids = urls.map((u) => u.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(newIndex, 0, moved);
    // Store doesn't have reorder yet — just optimistic local
    useDashboardStore.setState((state) => {
      const updated = [...urls];
      const [item] = updated.splice(index, 1);
      updated.splice(newIndex, 0, item);
      return {
        projectUrls: { ...state.projectUrls, [projectId]: updated },
      };
    });
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="saved-url-modal" onClick={(e) => e.stopPropagation()}>
        <div className="saved-url-modal-header">
          <h2>Saved URLs — {projectName}</h2>
          <button className="saved-url-modal-close" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="saved-url-modal-body">
          <div className="saved-url-form">
            <input
              className="saved-url-input mono"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label (e.g. Production)"
            />
            <input
              className="saved-url-input mono"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://example.com"
            />
            <button className="saved-url-add-btn" onClick={handleAdd}>
              Add
            </button>
          </div>

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
                  >
                    ▲
                  </button>
                  <button
                    className="saved-url-order-btn"
                    disabled={i === urls.length - 1}
                    onClick={() => moveItem(i, "down")}
                    title="Move down"
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
                    />
                    <input
                      className="saved-url-input mono"
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                    />
                    <button className="saved-url-add-btn" onClick={() => handleUpdate(u.id)}>
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
                    >
                      ✎
                    </button>
                    <button
                      className="saved-url-del-btn"
                      onClick={() => handleDelete(u.id)}
                      title="Delete"
                    >
                      <CloseIcon size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
