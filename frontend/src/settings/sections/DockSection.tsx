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
          "Keep preview worktrees on the branch's latest commit so the dev" +
          " server shows new changes. Turn off for dev servers without hot reload."
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
          "When a dev server (Vite, Next.js, Astro, …) starts in a regular" +
          " terminal, offer to use it as the project's preview. Mullion" +
          " always asks before changing the preview address."
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
          "Show a project's running Docker Compose services in the dock, with" +
          " logs, image tag, and update check. Services are never started" +
          " automatically."
        }
      >
        <Toggle
          testId="dock-docker-services-toggle"
          on={d.dockerServices}
          onChange={(v) => updateSettings({ dock: { dockerServices: v } })}
        />
      </Row>
      <Row
        label="Auto-attach Docker logs"
        desc={
          "Open each running Docker service's logs automatically. Each open" +
          " log uses a terminal session."
        }
      >
        <Toggle
          testId="dock-docker-autoattach-toggle"
          on={d.autoAttachDockerLogs}
          onChange={(v) => updateSettings({ dock: { autoAttachDockerLogs: v } })}
        />
      </Row>
    </>
  );
}
