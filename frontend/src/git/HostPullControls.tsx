import type { Project } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { useHostPull } from "./useHostPull.js";

export function HostPullControls({ project }: { project: Project | undefined }) {
  const hosts = useDashboardStore((s) => s.hosts);
  const { targets, pull, messages } = useHostPull(project, hosts);
  if (targets.length === 0) return null;
  return (
    <div className="github-panel-section" role="group" aria-label="Pull other host checkouts">
      {targets.map((target) => (
        <div key={target.id} className="github-panel-empty-row">
          <button
            type="button"
            className="git-panel-fetch-btn"
            disabled={!!target.unavailable || target.pending}
            title={target.unavailable ?? target.cwd}
            onClick={() => void pull(target.id)}
          >
            {target.pending ? "Pulling" : "Pull"} on {target.name}
          </button>
          {target.unavailable && <span> — {target.unavailable}</span>}
          {messages[target.key] && (
            <div role="status">
              {target.name}: {messages[target.key]}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
