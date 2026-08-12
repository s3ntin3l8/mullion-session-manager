import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { WarningTriangleIcon } from "./ui/icons.js";

interface Props {
  children: ReactNode;
  // Called when "Reload pane" is clicked — the parent (App.tsx's per-panel
  // wrapper) bumps a key on the crashed child so it remounts fresh. A class
  // component's own error state has no way to "retry" the exact subtree
  // that threw, so clearing local state alone isn't enough; the parent must
  // hand this boundary a genuinely new child.
  onReset: () => void;
}

interface State {
  error: Error | null;
}

// A crash inside one terminal pane (a WS/xterm bug, an unsupported addon
// option, whatever) shouldn't blank the entire dashboard, sidebar included —
// this is scoped around the dockview area alone so the rest of the app
// (project list, other already-open panes) stays usable. Restyled to the
// design's "Crashed pane — isolated" state (States doc section 04).
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[error-boundary]", error, info.componentStack);
  }

  handleReload = (): void => {
    this.props.onReset();
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="crashed-pane">
          <WarningTriangleIcon size={19} style={{ color: "var(--r)" }} />
          <div className="crashed-pane-title">This pane crashed</div>
          <div className="crashed-pane-subtitle">other panes are unaffected</div>
          <button className="crashed-pane-reload" onClick={this.handleReload}>
            Reload pane
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
