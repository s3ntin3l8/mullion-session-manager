// The right sidebar's shared TYPES.
//
// This file holds types and nothing else, on purpose: every view component
// imports its props type from here, so anything this file imported back
// would close an import cycle with the registry that lists those same
// components (issue #2414). The registry lives in views-registry.ts and the
// badge hooks in views-badges.ts.
import type { ComponentType, SVGProps } from "react";
import type { Device } from "../api/index.js";
import type { CheckoutChoice } from "../hooks/useCheckoutTarget.js";

type ViewIconProps = SVGProps<SVGSVGElement> & { size?: number };

// A count badge (changed files) or an attention badge (conflicts, failing
// CI). `title` is the rail button's tooltip suffix / the badge's a11y label.
export type RailBadge =
  { kind: "count"; value: number; title: string } | { kind: "alert"; title: string };

// Openers a view's "open the full panel" affordance calls — passed down from
// App.tsx so the sidebar never imports panel-opening machinery itself.
export interface RightSidebarActions {
  onOpenGit: (projectId: number) => void;
  onOpenGitHub: (projectId: number) => void;
  onOpenFileEditor: (projectId: number) => void;
  onOpenFile: (projectId: number, path: string, sessionId?: number) => void;
  onOpenAgentRules: (projectId: number) => void;
  onOpenProjectBriefing: (projectId: number) => void;
  onOpenProjectSetup: (projectId: number) => void;
  onOpenDockConfig: (projectId: number) => void;
  onOpenSkills: (projectId: number) => void;
  onOpenTasks: () => void;
  /** Open a device's screen as a grid pane. */
  onOpenDevice: (device: Device) => void;
}

export interface RightSidebarViewProps {
  projectId: number;
  /** The session whose own checkout (a git worktree) the focused panel is in,
   * when that differs from the project's — null otherwise. Only views that
   * browse files care. */
  checkoutSessionId?: number | null;
  /** The followed session and the user's project-default override, for the
   * chip that lets them flip between the two. */
  checkoutChoice?: CheckoutChoice;
  actions: RightSidebarActions;
}

export interface RightSidebarView {
  id: string;
  label: string;
  icon: ComponentType<ViewIconProps>;
  Component: ComponentType<RightSidebarViewProps>;
  // A hook (called once per rail button, so each view's subscription lives
  // in its own component — looping hooks in the parent would break the rules
  // of hooks). Required (use `useNoBadge`) so the rail never has to call a
  // hook conditionally. `null` means no badge.
  useBadge: (projectId: number | null) => RailBadge | null;
  // Whether the rail shows this view at all (same hook-per-button rule as
  // useBadge). `useAlwaysEnabled` for the views that are always there.
  useEnabled: () => boolean;
  // A host-global view (Devices) is not about the followed project: the panel
  // shows no project picker or "No projects yet" state for it and renders it
  // even with no project at all. It still receives `projectId`, but 0 then.
  hostGlobal?: boolean;
}
