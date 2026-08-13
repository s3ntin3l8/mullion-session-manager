import { useDashboardStore } from "../../store/index.js";
import { Row, Segmented, Toggle } from "../../ui/primitives.js";

export function DockSection() {
  const { settings, updateSettings } = useDashboardStore();
  const d = settings.dock;
  return (
    <>
      <Row
        label="Refresh worktree on agent commits"
        desc={
          "When a dock monitor runs in an auto-created preview worktree," +
          " periodically sync it to the branch's latest commit so the dev" +
          " server picks up changes live. Disable for non-HMR servers."
        }
      >
        <Toggle
          testId="dock-worktree-refresh-toggle"
          on={d.defaultWorktreeRefresh}
          onChange={(v) => updateSettings({ dock: { defaultWorktreeRefresh: v } })}
        />
      </Row>
      <Row
        label="Detect dev servers in plain sessions"
        desc={
          "When a dev server (Vite/Next/CRA/Astro) starts in an ordinary" +
          " terminal — not a dock control — offer to wire its port into" +
          ' the project\'s preview. "Off" disables the background scan' +
          " entirely; it never rewrites devServerUrl without asking."
        }
      >
        <Segmented
          value={d.autoDetectDevServer}
          onChange={(v) => updateSettings({ dock: { autoDetectDevServer: v } })}
          options={[
            { value: "ask", label: "Ask" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>
      <Row
        label="Docker Compose services"
        desc={
          "Show a project's running Compose services (log streams, image" +
          " tag, update check) alongside its dock.json monitors. A" +
          " discovered service still never starts on its own — this only" +
          " controls whether it appears at all."
        }
      >
        <Toggle
          testId="dock-docker-services-toggle"
          on={d.dockerServices}
          onChange={(v) => updateSettings({ dock: { dockerServices: v } })}
        />
      </Row>
    </>
  );
}
