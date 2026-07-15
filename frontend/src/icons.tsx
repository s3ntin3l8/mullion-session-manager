// SVG path data ported 1:1 from the Claude Design "Cmux design integration"
// project (Cmux Redesign.dc.html / Cmux States.dc.html) — kept as one shared
// module since Toolbar/Sidebar/CommandPalette/Dock/PaneTab all reuse the
// same icon set rather than each inlining its own copy of the paths.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 15, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function SidebarToggleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </Svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="7" height="7" rx="1.4" />
      <rect x="14" y="4" width="7" height="7" rx="1.4" />
      <rect x="3" y="15" width="7" height="5" rx="1.4" />
      <rect x="14" y="15" width="7" height="5" rx="1.4" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.9} {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.6} strokeLinecap="round" {...props}>
      <circle cx="12" cy="12" r="4.5" />
      <line x1="12" y1="1.5" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22.5" />
      <line x1="3.5" y1="3.5" x2="5.3" y2="5.3" />
      <line x1="18.7" y1="18.7" x2="20.5" y2="20.5" />
      <line x1="1.5" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22.5" y2="12" />
      <line x1="3.5" y1="20.5" x2="5.3" y2="18.7" />
      <line x1="18.7" y1="5.3" x2="20.5" y2="3.5" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
    </Svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.6} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="9 18 15 12 9 6" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.6} {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function OverflowIcon(props: IconProps) {
  return (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="currentColor" {...props}>
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 12.5l5 5L20 6.5" />
    </Svg>
  );
}

export function KillIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.9} {...props}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="7" x2="12" y2="13" />
      <line x1="12" y1="16.5" x2="12" y2="16.6" />
    </Svg>
  );
}

export function RenameIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Svg>
  );
}

export function MoveIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} {...props}>
      <polyline points="5 9 2 12 5 15" />
      <polyline points="9 5 12 2 15 5" />
      <polyline points="15 19 12 22 9 19" />
      <polyline points="19 9 22 12 19 15" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </Svg>
  );
}

// Ported verbatim from the design's connecting/reconnecting overlay — a
// partial arc, spun via the .terminal-status-spinner CSS classes (1s
// connecting / 1.4s reconnecting, colored --muted/--o respectively).
export function SpinnerIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" {...props}>
      <path d="M21 12a9 9 0 1 1-6.2-8.5" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10" />
    </Svg>
  );
}

export function SplitRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="13" y1="4" x2="13" y2="20" />
    </Svg>
  );
}

export function SplitDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <line x1="4" y1="13" x2="20" y2="13" />
    </Svg>
  );
}

// Ported verbatim from the design's empty/connection states doc
// (Cmux States.dc.html, sections 03/04). Fill-based (a solid white glyph
// inside an accent-tinted square), not stroke-based like the rest of this
// module — used only inside the "welcome" empty state's icon badge.
export function PlayTriangleIcon(props: IconProps) {
  return (
    <svg width={props.size ?? 15} height={props.size ?? 15} viewBox="0 0 24 24" fill="#fff" {...props}>
      <polygon points="7 5 18 12 7 19" />
    </svg>
  );
}

// A terminal-window-with-prompt glyph for the "project open, no sessions"
// empty state. The extraction only partially captured this one's exact path
// data ("rect + polyline + line") — this is a close, standard reconstruction
// of that description rather than a byte-exact port.
export function TerminalPromptIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <polyline points="7 9 10 12 7 15" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="15" x2="16" y2="15" strokeLinecap="round" />
    </Svg>
  );
}

// A magnifier with an alert mark, for "discovery ran, nothing found."
export function SearchAlertIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} {...props}>
      <circle cx="10" cy="10" r="7" />
      <line x1="21" y1="21" x2="15.5" y2="15.5" />
      <line x1="10" y1="7" x2="10" y2="11" />
      <line x1="10" y1="13.5" x2="10" y2="13.6" />
    </Svg>
  );
}

// Ported verbatim from the design's "Disconnected" state.
export function WifiOffIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} strokeLinecap="round" {...props}>
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M2 8.8a15 15 0 0 1 20 0" />
      <line x1="1" y1="1" x2="23" y2="23" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </Svg>
  );
}

// The extraction's description ("warning-triangle SVG") was truncated
// mid-path — this is the standard, widely-recognized alert-triangle glyph
// rather than a byte-exact port of the design's own path data.
export function WarningTriangleIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  );
}

// The extraction's description ("two stacked rects + status dots") — same
// caveat as WarningTriangleIcon, a close standard reconstruction.
export function ServerRackIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} {...props}>
      <rect x="2" y="3" width="20" height="7" rx="1.8" />
      <rect x="2" y="14" width="20" height="7" rx="1.8" />
      <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
      <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
    </Svg>
  );
}

// A 6-dot drag handle, ported verbatim from the design's "reorder group" /
// "drag session into group" mockups (Cmux States.dc.html, section 07) — the
// only draggable element on a workspace/group row (see reorder.ts / the
// plan's Phase 4d design decision #1: the grip is the drag source, never
// the row itself).
export function GripIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} {...props}>
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </Svg>
  );
}

export function DockIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.7} {...props}>
      <rect x="3" y="14" width="18" height="6" rx="1.6" />
      <rect x="3" y="4" width="18" height="6" rx="1.6" />
    </Svg>
  );
}
