import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/index.js";
import type { AppSettings, Launcher, Project, Session } from "../api/index.js";
import type { PlacementPreview } from "../api/types.js";
import { useDashboardStore } from "../store/index.js";
import {
  STORAGE_KEYS,
  readJSON,
  readNumber,
  writeJSON,
  writeNumber,
} from "../lib/persistedState.js";
import { projectHostCount } from "../lib/hostBadge.js";
import { resolveActiveProjectId } from "../panelUtils.js";
import {
  AUTO_VALUE,
  buildHostTargetOptions,
  rememberHostChoice,
  resolveHostChoice,
  withoutAutoChoices,
} from "../command-palette/hostTarget.js";
import { commandHasModelFlag, commandModelCli, useModelOptions } from "../models/modelCatalogs.js";
import type { ModelCli } from "../models/modelCatalogs.js";
import { resolveSkipPermissions } from "./skipPermissions.js";

// The launch path shared by the command palette (CommandPalette.tsx) and the
// New session launcher (SessionLauncher.tsx, issue #3013). Both surfaces pick
// the same things — a project, a host, worktree isolation, a launcher, its
// model and skip-permissions — and both must send exactly the same request for
// the same choices, so everything that turns those choices into a
// createSession call lives here, once. The two components own only their own
// presentation (a searchable list vs. tiles and a list).

// Expands Settings -> Session management's naming-pattern tokens
// ({agent} {project} {n}) into a concrete session name at launch time — see
// settings.sessions.namePattern (default "{agent} · {project}"). A falsy
// result (empty pattern, or a pattern that expands to only whitespace)
// yields `undefined` so callers fall back to the sessions route's own
// "name ?? command" display convention rather than persisting an empty name.
export function expandSessionNamePattern(
  pattern: string,
  tokens: { agent: string; project: string; n: number },
): string | undefined {
  const expanded = pattern
    .replaceAll("{agent}", tokens.agent)
    .replaceAll("{project}", tokens.project)
    .replaceAll("{n}", String(tokens.n))
    .trim();
  return expanded.length > 0 ? expanded : undefined;
}

// The project a fresh launcher opens on. A project-scoped open is bound to
// its project. Otherwise: the focused pane's project (a killed session pane
// doesn't count, and neither does a stale id no longer in `projects`), then
// the last project launched into, then the first project.
export function resolveInitialLaunchProjectId(input: {
  scope: "global" | "project";
  projectId: number | null;
  activePanelId: string | null;
  sessions: Session[];
  projects: Project[];
}): number | null {
  const { scope, projectId, activePanelId, sessions, projects } = input;
  if (scope === "project") return projectId;
  const paneProjectId =
    activePanelId?.startsWith("session-") === true
      ? (sessions.find((s) => activePanelId === `session-${s.id}` && s.status !== "killed")
          ?.projectId ?? null)
      : resolveActiveProjectId(activePanelId, sessions);
  const pane = projects.find((p) => p.id === paneProjectId);
  if (pane) return pane.id;
  const stored = readNumber(STORAGE_KEYS.lastLaunchProjectId, 0);
  return (projects.find((p) => p.id === stored) ?? projects[0] ?? null)?.id ?? null;
}

// GET /api/projects/:id/actions for the target project. `onLoaded` runs in
// the same callback as the state update, so a caller's own selection seed
// (the palette's default-agent highlight) lands in the same render as the
// list it indexes into.
export function useProjectLaunchers(
  projectId: number | null,
  onLoaded?: (launchers: Launcher[]) => void,
) {
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  // The project whose request has settled — derived "loaded", so a project
  // switch reads as loading again without a synchronous setState in the effect.
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });
  useEffect(() => {
    if (projectId === null) return;
    // A fast project switch (1 -> 2 -> 3) must not let project 1's slower
    // response overwrite project 3's launchers.
    let ignore = false;
    api
      .listProjectActions(projectId)
      .then((fetched) => {
        if (ignore) return;
        setLaunchers(fetched);
        setLoadedFor(projectId);
        onLoadedRef.current?.(fetched);
      })
      .catch(() => {
        if (ignore) return;
        setLaunchers([]);
        setLoadedFor(projectId);
      });
    return () => {
      ignore = true;
    };
  }, [projectId]);
  return { launchers, loaded: projectId !== null && loadedFor === projectId };
}

// Issue #2237 — the launch's host target and issue #271's worktree isolation,
// for one project. `rememberedHosts` mirrors the persisted project id ->
// choice map; the EFFECTIVE choice is derived from it against the current
// project/hosts so a host that has left the project falls back to the default
// (null = the project's own host).
export function useLaunchTarget(target: Project | null, sessions: Session[]) {
  const hosts = useDashboardStore((s) => s.hosts);
  const [rememberedHosts, setRememberedHosts] = useState<Record<string, string>>(() =>
    withoutAutoChoices(readJSON<Record<string, string>>(STORAGE_KEYS.lastLaunchHostByProject, {})),
  );
  const [autoPreview, setAutoPreview] = useState<{
    projectId: number;
    preview: PlacementPreview | null;
  } | null>(null);
  // Off by default; <WorktreeOptions> only fetches branches once the toggle
  // is switched on. Lifted here because the launch reads both at launch time.
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [worktreeBaseRef, setWorktreeBaseRef] = useState("");

  const targetId = target?.id ?? null;
  // Only a project reaching more than one host (its own plus its `hostCwds`)
  // gets a host choice; a single-host project launches as before.
  const hostOptions = useMemo(
    () => (target ? buildHostTargetOptions(target, hosts) : []),
    [target, hosts],
  );
  const showHostChip = target !== null && projectHostCount(target, sessions) > 1;
  const hostChoice = target
    ? resolveHostChoice(rememberedHosts[String(target.id)], target, hosts, true)
    : null;
  // "Elsewhere" = a base ref from this host's branches is not safe: another
  // host, or Auto. The project's own host (explicit, on an auto project) is not.
  const placedElsewhere =
    showHostChip && hostChoice !== null && (target === null || hostChoice !== target.hostId);
  useEffect(() => {
    if (!showHostChip || hostChoice !== AUTO_VALUE || targetId === null) return;
    let cancelled = false;
    api
      .getPlacementPreview(targetId, "auto")
      .then((preview) => {
        if (!cancelled) setAutoPreview({ projectId: targetId, preview });
      })
      .catch(() => {
        if (!cancelled) setAutoPreview({ projectId: targetId, preview: null });
      });
    return () => {
      cancelled = true;
    };
  }, [showHostChip, hostChoice, targetId]);
  const onHostChange = (value: string) => {
    if (!target) return;
    const next = rememberHostChoice(rememberedHosts, target, value);
    setRememberedHosts(next);
    writeJSON(STORAGE_KEYS.lastLaunchHostByProject, withoutAutoChoices(next));
  };

  return {
    hosts,
    hostOptions,
    showHostChip,
    hostChoice,
    placedElsewhere,
    onHostChange,
    // The Auto preview, only when it belongs to the current project.
    autoPreview:
      autoPreview !== null && autoPreview.projectId === targetId ? autoPreview.preview : null,
    worktreeEnabled,
    setWorktreeEnabled,
    worktreeBaseRef,
    setWorktreeBaseRef,
  };
}

export type LaunchTarget = ReturnType<typeof useLaunchTarget>;

// The settings default model for a CLI, for the model select's "Default (…)"
// option.
export function settingsDefaultModel(settings: AppSettings, cli: ModelCli | null) {
  return cli === "claude-code"
    ? settings.claudeCode?.defaultModel
    : cli === "codex"
      ? settings.codex?.defaultModel
      : cli === "agy"
        ? settings.agy?.defaultModel
        : cli === "opencode"
          ? settings.opencode?.implementerModel
          : null;
}

// Issue #1424 — the per-session model override for whichever launcher is
// currently selected. It is keyed to the CLI it was picked for, and reads back
// as "no override" the moment the selection's CLI no longer matches — moving
// from Claude to Codex must never carry a Claude model over to a Codex launch.
export function useLaunchModel(activeCommand: string | null) {
  const settings = useDashboardStore((s) => s.settings);
  const [override, setOverride] = useState<{ cli: ModelCli; value: string | null } | null>(null);
  const activeCli = activeCommand !== null ? commandModelCli(activeCommand) : null;
  // A command that already has its own --model (or codex's -m) flag keeps it —
  // offering a picker the backend would then silently ignore (buildModelFlag's
  // own skip-if-present rule, hook-adapters/shared.ts) would be misleading.
  const show =
    activeCli !== null && activeCommand !== null && !commandHasModelFlag(activeCommand, activeCli);
  // Called unconditionally (rules of hooks). "claude-code" is a safe,
  // no-fetch fallback; the result is not rendered when `show` is false.
  const catalog = useModelOptions(activeCli ?? "claude-code");
  const value = activeCli !== null && override?.cli === activeCli ? override.value : null;
  const settingsDefault = settingsDefaultModel(settings, activeCli);
  return {
    activeCli,
    show,
    catalog,
    value,
    defaultLabel: settingsDefault ? `Default (${settingsDefault})` : "CLI default",
    setValue: (v: string | null) => {
      if (activeCli === null) return;
      setOverride({ cli: activeCli, value: v });
    },
    // The model to send for a launch of `command`. Re-derives the CLI from the
    // launched command itself rather than trusting the selection, so a click
    // on a row other than the highlighted one can never pick up its model.
    // `undefined` (not sent) unless an override was set for this exact CLI and
    // isn't the default option — the backend then resolves the settings
    // default as if the picker had never rendered.
    forLaunch: (command: string): string | undefined => {
      const cli = commandModelCli(command);
      return override && override.cli === cli && override.value !== null
        ? override.value
        : undefined;
    },
  };
}

// The launch itself. A failed launch (a 4xx from a bad worktree base ref, a
// 503 from a dead remote host, ...) must surface where the user is looking and
// must NOT close the surface — closing would unmount the very component about
// to render the error. `launching` is an in-flight guard: a held Enter must
// not start a second session.
export function useLaunchSession({
  target,
  launchTarget,
  onLaunched,
}: {
  target: Project | null;
  launchTarget: LaunchTarget;
  onLaunched: (session: Session) => void;
}) {
  const settings = useDashboardStore((s) => s.settings);
  const sessions = useDashboardStore((s) => s.sessions);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const launch = (
    launcher: Launcher,
    options: { model?: string; skipPermissionsOverride?: boolean | null } = {},
  ) => {
    if (target === null || launching) return;
    const projectId = target.id;
    const name = expandSessionNamePattern(settings.sessions.namePattern, {
      agent: launcher.title,
      project: target.name,
      n: sessions.filter((s) => s.projectId === projectId).length + 1,
    });
    const { placedElsewhere, showHostChip, hostChoice, worktreeEnabled } = launchTarget;
    const trimmedBaseRef = launchTarget.worktreeBaseRef.trim();
    setLaunching(true);
    setLaunchError(null);
    useDashboardStore
      .getState()
      .createSession(projectId, launcher.command, {
        // A launcher's cwd is a path on the project's own host; it means
        // nothing on another one (and `isolate` excludes it).
        cwd: placedElsewhere ? undefined : launcher.cwd,
        name,
        // A base ref picked here is unsafe on another host: send `isolate`
        // and let the server cut the worktree from that host's default.
        worktree:
          worktreeEnabled && !placedElsewhere && trimmedBaseRef
            ? { baseRef: trimmedBaseRef }
            : undefined,
        isolate: worktreeEnabled && placedElsewhere ? true : undefined,
        targetHostId:
          showHostChip && hostChoice !== null && hostChoice !== AUTO_VALUE ? hostChoice : undefined,
        placement: showHostChip && hostChoice === AUTO_VALUE ? "auto" : undefined,
        model: options.model,
        skipPermissions: resolveSkipPermissions(
          launcher,
          settings,
          options.skipPermissionsOverride,
        ),
      })
      .then((session) => {
        // Only a launch that happened becomes the next open's default project.
        writeNumber(STORAGE_KEYS.lastLaunchProjectId, projectId);
        onLaunched(session);
      })
      .catch((err: unknown) => {
        console.debug("[launch] failed", err);
        setLaunching(false);
        setLaunchError(err instanceof Error ? err.message : "Failed to launch — try again.");
      });
  };

  return { launch, launching, launchError };
}
