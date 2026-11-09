import { useState } from "react";
import { ApiError } from "../api/index.js";
import { Dropdown, TextInput } from "../ui/primitives.js";

// The board's inline "New task" form, split out of the former TasksToolbar (#2840).
// The parent decides whether it is shown; `createTask` is threaded in from the board
// so this component needs no store access of its own.
export function NewTaskForm({
  projects,
  createTask,
  onCreated,
}: {
  projects: { id: number; name: string }[];
  createTask: (projectId: number, title: string) => Promise<unknown>;
  onCreated: () => void;
}) {
  const [manualProjectId, setManualProjectId] = useState<number | null>(null);
  const projectId =
    manualProjectId !== null && projects.some((p) => p.id === manualProjectId)
      ? manualProjectId
      : (projects[0]?.id ?? null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!title.trim() || projectId === null || submitting) return;
    setSubmitting(true);
    setError(null);
    createTask(projectId, title.trim())
      .then(() => {
        setTitle("");
        onCreated();
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to create task");
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="tasks-panel-new-form">
      <Dropdown
        small
        className="tasks-panel-new-project"
        ariaLabel="Project"
        value={String(projectId ?? "")}
        onChange={(v) => setManualProjectId(Number(v))}
        options={projects.map((p) => ({ value: String(p.id), label: p.name }))}
      />
      <TextInput
        small
        className="tasks-panel-new-title"
        placeholder="Task title"
        value={title}
        autoFocus
        disabled={submitting}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <button
        className="tasks-panel-new-submit"
        disabled={!title.trim() || projectId === null || submitting}
        onClick={submit}
      >
        {submitting ? "Creating…" : "Create"}
      </button>
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}
