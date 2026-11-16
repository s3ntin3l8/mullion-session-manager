import { useState } from "react";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { TerminalPane } from "../TerminalPane.js";
import { HalfHeader } from "./HalfHeader.js";
import type { HalfHeaderProps } from "./HalfHeader.js";

export interface RightHalfPaneProps extends Pick<
  HalfHeaderProps,
  "renderActions" | "onRenameCommit"
> {
  sessionId: number;
  title: string;
  projectName: string | null;
  focused: boolean;
  onMoveLeft: () => void;
  onClose: () => void;
  /** A press or focus inside the half: it now has focus and was used last. */
  onUse: () => void;
  /** Ctrl/Cmd-click (a tap on touch) on a path the terminal printed (#3034). */
  onOpenFile?: (path: string, line?: number) => void;
}

// The right half's session between 800 and 1099px (#3010): its terminal on
// its own, beside the grid, the way the Dock renders a monitor. The grid's
// copy of the same session stands aside meanwhile (panels/registry.tsx), so
// one terminal is mounted per session.
export function RightHalfPane({
  sessionId,
  title,
  projectName,
  focused,
  onMoveLeft,
  onClose,
  onUse,
  onOpenFile,
  renderActions,
  onRenameCommit,
}: RightHalfPaneProps) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <div
      className={`fold-half fold-half-right${focused ? " focused" : ""}`}
      onPointerDownCapture={onUse}
      onFocusCapture={onUse}
    >
      <HalfHeader
        side="right"
        title={title}
        projectName={projectName}
        onMove={onMoveLeft}
        onClose={onClose}
        focused={focused}
        renderActions={renderActions}
        onRenameCommit={onRenameCommit}
      />
      <div className="fold-half-body">
        <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
          <TerminalPane
            key={`${sessionId}-${resetKey}`}
            params={{ sessionId }}
            active={focused}
            onOpenFile={onOpenFile}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
