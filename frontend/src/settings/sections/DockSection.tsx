import { useDashboardStore } from "../../store/index.js";
import { Row, Segmented, Toggle } from "../../ui/primitives.js";
import { DOCK_UNAVAILABLE } from "../../lib/dockAvailability.js";
import { useDockUnavailableReason } from "../../lib/useDockUnavailableReason.js";

export function DockSection() {
  const { settings, updateSettings } = useDashboardStore();
  const d = settings.dock;
  // The Dock is hidden by tablet.css's `(pointer: coarse)` block AND by
  // mobile.css's phone-tier block, so this asks the shared predicate rather
  // than testing the pointer alone (issue #1881). The palette's Dock command
  // says the same thing, from the same source.
  const unavailable = useDockUnavailableReason();
  const reason = unavailable ? DOCK_UNAVAILABLE[unavailable].text : null;
  return (
    <>
      {reason && (
        <div className="settings-footer-note">
          {reason.charAt(0).toUpperCase() + reason.slice(1)}, so its Docker services and log panes
          have nowhere to show. These settings still apply — the preview worktree and dev-server
          ones work either way.
        </div>
      )}
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
