import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { BridgeSummary } from "../../api/index.js";
import { PairBridgeModal } from "../../PairBridgeModal.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { usePolling } from "../../hooks/usePolling.js";
import { HostsIcon, PlusIcon } from "../../ui/icons.js";
import {
  AddButton,
  GroupHeading,
  ListRow,
  SecondaryButton,
  StyledList,
} from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";

// Issue #820 PR7c — same "these change rarely, poll on a live interval
// while the section is open, own local state rather than the dashboard
// store" shape as BrowserCookiesSection.tsx: bridges aren't referenced
// anywhere outside Settings (unlike `hosts`, which Sidebar/HostConfigModal
// also read), so there's no cross-component staleness to guard against by
// threading this through useDashboardStore.
const BRIDGES_POLL_MS = 4000;

// Self-review (mullion-reviewer) — `hasLiveSession: false` is NEVER what a
// revoked bridge looks like: DELETE /api/bridges/:id deletes the row
// outright (deleteBridge), so a revoked bridge simply disappears from this
// list entirely, not "shows up with no session." The two real states this
// branch covers instead: `lastSeenAt === null` is a pairing code that was
// issued (POST /api/bridges — every call inserts a row immediately, before
// the helper ever redeems it) but never actually paired yet — exactly the
// row that appears in this list WHILE PairBridgeModal is still open
// waiting; `lastSeenAt` set means it WAS paired once (redeemPairingCode
// sets lastSeenAt in the same transaction as the session fields —
// bridge-registry.ts) and its session has since lapsed (24h TTL,
// unrenewed). Revoke still works correctly on either — this is a label
// fix only, not a new action.
function describeBridge(bridge: BridgeSummary): string {
  if (bridge.connected) return "connected";
  if (!bridge.hasLiveSession)
    return bridge.lastSeenAt === null ? "pairing pending" : "session expired";
  if (bridge.lastSeenAt)
    return `last seen ${formatRelativeAge(new Date(bridge.lastSeenAt).getTime())}`;
  // Unreachable in practice — hasLiveSession only ever becomes true in the
  // same transaction that sets lastSeenAt — kept as a harmless fallback
  // rather than a non-null assertion on backend-controlled data.
  return "paired, never seen";
}

export function BridgesSection() {
  const [bridges, setBridges] = useState<BridgeSummary[] | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // Tracks an in-flight revoke per row so a double-click can't fire the
  // DELETE twice — KebabMenu's own `confirm: true` already requires a
  // second click to arm this, but nothing stops a third rapid click before
  // the first request resolves and this row disappears from `bridges`.
  const [revoking, setRevoking] = useState<Record<string, boolean>>({});

  const refresh = () => {
    api
      .listBridges()
      .then(setBridges)
      .catch(() => setBridges((prev) => prev ?? []));
  };

  useEffect(refresh, []);
  usePolling(refresh, BRIDGES_POLL_MS, { pauseWhenHidden: true, immediate: false });

  const revoke = (bridge: BridgeSummary) => {
    setRevokeError(null);
    setRevoking((prev) => ({ ...prev, [bridge.id]: true }));
    api
      .revokeBridge(bridge.id)
      .then(() => {
        setBridges((prev) => (prev ? prev.filter((b) => b.id !== bridge.id) : prev));
      })
      .catch((err: unknown) => {
        setRevokeError(err instanceof ApiError ? err.message : "Could not revoke this bridge");
      })
      .finally(() => {
        setRevoking((prev) => {
          const next = { ...prev };
          delete next[bridge.id];
          return next;
        });
      });
  };

  return (
    <>
      <GroupHeading
        title="SSH agent bridges"
        desc="Laptops/PCs whose SSH agent (e.g. 1Password) is forwarded to every enrolled host."
      />
      {bridges === null && <div className="settings-readonly-value">Loading…</div>}
      {bridges !== null && bridges.length > 0 && (
        <StyledList>
          {bridges.map((bridge) => (
            <ListRow
              key={bridge.id}
              testId={`bridge-row-${bridge.id}`}
              icon={<HostsIcon size={15} />}
              dot={bridge.connected ? "on" : "off"}
              title={bridge.name ?? "unnamed helper"}
              subtitle={bridge.platform ?? undefined}
              trailing={
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10.5, color: "var(--dim)" }}>
                    {describeBridge(bridge)}
                  </span>
                  <SecondaryButton
                    onClick={() => revoke(bridge)}
                    disabled={revoking[bridge.id] ?? false}
                  >
                    Revoke
                  </SecondaryButton>
                </div>
              }
            />
          ))}
        </StyledList>
      )}
      {revokeError && <ErrorText style={{ marginTop: 8 }}>{revokeError}</ErrorText>}

      <div style={{ marginTop: 10 }}>
        <AddButton onClick={() => setPairOpen(true)}>
          <PlusIcon size={13} />
          Pair a new bridge
        </AddButton>
      </div>

      {bridges !== null && bridges.length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>
          No SSH agent bridges paired — a session's SSH_AUTH_SOCK falls back to whatever's
          configured or ambient on the host it runs on until you pair one.
        </div>
      )}

      {pairOpen && (
        <PairBridgeModal
          onClose={() => setPairOpen(false)}
          onPaired={() => {
            refresh();
          }}
        />
      )}
    </>
  );
}
