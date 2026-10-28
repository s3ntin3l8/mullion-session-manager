import { useEffect, useRef, useState } from "react";
import { api } from "./api/index.js";
import type { ProjectPreviewConfig } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { ErrorText } from "./ui/ErrorText.js";

export function PreviewTargetsEditor({ projectId }: { projectId: number }) {
  const [draft, setDraft] = useState<ProjectPreviewConfig>();
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const project = useDashboardStore((s) => s.projects.find((p) => p.id === projectId));
  const load = () => api.getProjectPreviewTargets(projectId);
  useEffect(() => {
    let cancelled = false;
    void api
      .getProjectPreviewTargets(projectId)
      .then((config) => {
        if (!cancelled) {
          setDraft(config);
          setSaved(JSON.stringify(config));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const save = async () => {
    if (!draft || saving) return;
    const submitted = draft;
    setSaving(true);
    setError(null);
    try {
      const config = await api.saveProjectPreviewTargets(projectId, submitted);
      useDashboardStore.setState((state) => ({
        projectPreviewConfigs: { ...state.projectPreviewConfigs, [projectId]: config },
        projects: state.projects.map((p) =>
          p.id === projectId ? { ...p, devServerUrl: config.devServerUrl } : p,
        ),
      }));
      setSaved(JSON.stringify(config));
      if (draftRef.current === submitted) setDraft(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const incomplete = draft?.targets.some(
    (target) => !target.name.trim() || !target.destination.trim(),
  );
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  return (
    <section className="preview-targets-editor" aria-label="Preview destinations">
      <div className="preview-config-toolbar">
        <h3>Previews</h3>
        <button
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(JSON.parse(saved) as ProjectPreviewConfig);
            setError(null);
          }}
        >
          Discard
        </button>
        <button disabled={!dirty || saving || incomplete} onClick={() => void save()}>
          {saving ? "Saving…" : "Save previews"}
        </button>
      </div>
      {incomplete && (
        <p role="status">Enter a name and destination for every preview target before saving.</p>
      )}
      <p>Named destinations for this project. Changes apply when you open or reload a preview.</p>
      {error && <ErrorText>{error}</ErrorText>}
      {!draft ? (
        <button
          onClick={() =>
            void load()
              .then((config) => {
                setDraft(config);
                setSaved(JSON.stringify(config));
                setError(null);
              })
              .catch((err: unknown) => setError(String(err)))
          }
        >
          Retry loading previews
        </button>
      ) : (
        <>
          <fieldset>
            <legend>Dev server</legend>
            <label>
              Dev server destination
              <input
                value={draft.devServerUrl ?? ""}
                placeholder="5173 or http://host:5173"
                onChange={(e) => setDraft({ ...draft, devServerUrl: e.target.value || null })}
              />
            </label>
            <p>The existing project preview. Leave blank to clear.</p>
            {project?.detectedDevServerPort &&
              project.detectedDevServerPort !== draft.devServerUrl && (
                <button
                  onClick={() =>
                    setDraft({ ...draft, devServerUrl: project.detectedDevServerPort })
                  }
                >
                  Detected dev server on port {project.detectedDevServerPort} — use it?
                </button>
              )}
          </fieldset>
          {draft.targets.map((target, index) => (
            <fieldset key={target.id}>
              <legend>{target.name || "New target"}</legend>
              <label>
                Target name
                <input
                  aria-label={`Target ${index + 1} name`}
                  value={target.name}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      targets: draft.targets.map((t) =>
                        t.id === target.id ? { ...t, name: e.target.value } : t,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Destination
                <input
                  aria-label={`Target ${index + 1} destination`}
                  value={target.destination}
                  placeholder="192.168.1.20:8080 or https://example.com/docs"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      targets: draft.targets.map((t) =>
                        t.id === target.id ? { ...t, destination: e.target.value } : t,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Connect from
                <select
                  aria-label={`Target ${index + 1} connection origin`}
                  value={target.connectionOrigin}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      targets: draft.targets.map((t) =>
                        t.id === target.id
                          ? { ...t, connectionOrigin: e.target.value as "project" | "primary" }
                          : t,
                      ),
                    })
                  }
                >
                  <option value="project">Project host</option>
                  <option value="primary">Main Mullion server</option>
                </select>
              </label>
              <p>
                Localhost refers to the selected machine. Opening this target does not start a
                service.
              </p>
              <button
                onClick={() =>
                  setDraft({ ...draft, targets: draft.targets.filter((t) => t.id !== target.id) })
                }
              >
                Remove target
              </button>
            </fieldset>
          ))}
          <button
            onClick={() =>
              setDraft({
                ...draft,
                targets: [
                  ...draft.targets,
                  {
                    id: crypto.randomUUID(),
                    name: "",
                    destination: "",
                    connectionOrigin: "project",
                  },
                ],
              })
            }
          >
            Add preview target
          </button>
        </>
      )}
    </section>
  );
}
