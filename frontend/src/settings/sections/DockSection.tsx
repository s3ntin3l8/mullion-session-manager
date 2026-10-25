import { useDashboardStore } from "../../store/index.js";
import { Row, Segmented, Toggle } from "../../ui/primitives.js";
import { useCoarsePointer } from "../../lib/layoutTier.js";

export function DockSection() {
  const { settings, updateSettings } = useDashboardStore();
  const d = settings.dock;
  // The Dock is hidden by tablet.css's `(pointer: coarse)` block, and that
  // media query is the only thing that decides it — so the section says the
  // same thing the palette's Dock command says, on exactly the devices where
  // the Dock cannot be shown (issue #1881).
  const dockAvailable = !useCoarsePointer();
  return (
    <>
      {!dockAvailable && (
        <div className="settings-footer-note">
          The Dock is hidden on touch-only devices, so the Docker settings below have nowhere to
          show until you use a mouse or trackpad. They still apply, and the preview settings above
          work either way.
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
