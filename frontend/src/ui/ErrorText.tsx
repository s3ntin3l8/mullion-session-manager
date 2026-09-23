import type { CSSProperties, ReactNode } from "react";

// PR 25 (frontend refactor plan) — `<div style={{ fontSize: 12, color:
// "var(--r)" }} role="alert">{error}</div>` (sometimes with `marginTop: 8`
// or `flex: 1` added) was hand-rolled at 17 call sites across 9 files
// (ServerInfoSection, CreateHostModal, HostConfigModal, GitHubDeviceFlowModal,
// AuthGate, BrowserCookiesSection, IntegrationsSection, HostsSection). No
// shared CSS class existed for it — it was always an inline style object —
// so this keeps the same inline-style shape rather than inventing a new
// class, and `style` merges in last so per-site overrides (`marginTop`,
// `flex`) still work unchanged.
export function ErrorText({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={className} style={{ fontSize: 12, color: "var(--r)", ...style }} role="alert">
      {children}
    </div>
  );
}
