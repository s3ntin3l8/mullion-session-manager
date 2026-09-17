import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { api, ApiError } from "../../api/index.js";
import type { BridgeSummary } from "../../api/index.js";
import { PairBridgeModal } from "../../PairBridgeModal.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { usePolling } from "../../hooks/usePolling.js";
import { computeReorder } from "../../reorder.js";
import type { ReorderItem } from "../../reorder.js";
import { GripIcon, HostsIcon, PlusIcon } from "../../ui/icons.js";
import { AddButton, GroupHeading, ListRow, StyledList } from "../../ui/primitives.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
import { ErrorText } from "../../ui/ErrorText.js";

// Issue #1313 — drag-to-reorder priority among enrolled bridges. Bridge
// ids are string UUIDs (bridges.id, src/db/schema.ts), but reorder.ts's
// computeReorder was written for WorkspaceSwitcher.tsx's numeric
// workspace ids and grouped buckets — this list has neither. Rather than
// forking that math, this maps each bridge to its ARRAY INDEX as a
// throwaway numeric id in a single ungrouped bucket (`groupId: null`
// throughout), runs the exact same computeReorder, then translates the
// resulting position order back to real bridge ids by that same index —
// the reuse the issue asks for, adapted to this list's id type rather
// than a parallel reimplementation of the drag math itself.
function reorderedBridgeIds(
  bridges: BridgeSummary[],
  draggedId: string,
  targetIndex: number,
): string[] {
  const draggedIndex = bridges.findIndex((b) => b.id === draggedId);
  if (draggedIndex === -1) return bridges.map((b) => b.id);

  const items: ReorderItem[] = bridges.map((_, index) => ({
    id: index,
    groupId: null,
    position: index,
  }));
  const updates = computeReorder(items, draggedIndex, targetIndex, null);

  const positionByIndex = new Map<number, number>(items.map((item) => [item.id, item.position]));
  for (const update of updates) positionByIndex.set(update.id, update.position);

  return bridges
    .map((_, index) => index)
    .sort((a, b) => positionByIndex.get(a)! - positionByIndex.get(b)!)
    .map((index) => bridges[index].id);
}

// Issue #820 PR7c — same "these change rarely, poll on a live interval
// while the section is open, own local state rather than the dashboard
// store" shape as BrowserCookiesSection.tsx: bridges aren't referenced
// anywhere outside Settings (unlike `hosts`, which Sidebar/HostConfigModal
// also read), so there's no cross-component staleness to guard against by
// threading this through useDashboardStore.
export const BRIDGES_POLL_MS = 4000;

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
  // Hermes review, PR #869 — a failed fetch used to fall through to the
  // exact same `bridges.length === 0` branch a genuinely empty list does,
  // rendering "No SSH agent bridges paired" (which reads as a confirmed
  // fact) for what might actually be "couldn't reach the server right
  // now." Tracked separately so the render below can tell the two apart.
  const [loadError, setLoadError] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // Tracks an in-flight revoke per row so a double-click can't fire the
  // DELETE twice — ConfirmButton already requires two separate clicks
  // (arm, then confirm) before this fires at all, but nothing stops a
  // third rapid click before the first request resolves and this row
  // disappears from `bridges`.
  const [revoking, setRevoking] = useState<Record<string, boolean>>({});

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  // Issue #1313 — this section polls every BRIDGES_POLL_MS, and refresh()
  // below overwrites `bridges` wholesale. Without this guard, a poll
  // landing mid-drag (or after an optimistic reorder that hasn't
  // round-tripped yet) would snap the list back to the pre-drag/pre-save
  // order, visually reverting a drop that actually succeeded. Plain refs
  // (not state) — refresh() only needs the CURRENT value at call time, and
  // a ref sidesteps exhaustive-deps wanting `draggingId`/`reordering` in
  // the empty-deps mount effect below, which only ever needs to run once.
  // Kept in sync with `draggingId` state (needed for render) at every
  // setter call site rather than via a mirroring effect, so there's no
  // extra render-cycle lag between a drag starting and refresh() noticing.
  const draggingRef = useRef<string | null>(null);
  const reorderingRef = useRef(false);

  const refresh = () => {
    api
      .listBridges()
      .then((result) => {
        setLoadError(false);
        setBridges((prev) =>
          draggingRef.current !== null || reorderingRef.current ? prev : result,
        );
      })
      .catch(() => {
        setLoadError(true);
        setBridges((prev) => prev ?? []);
      });
  };

  useEffect(refresh, []);
  usePolling(refresh, BRIDGES_POLL_MS, { pauseWhenHidden: true, immediate: false });

  const startDrag = (bridgeId: string) => {
    draggingRef.current = bridgeId;
    setDraggingId(bridgeId);
  };

  const endDrag = () => {
    draggingRef.current = null;
    setDraggingId(null);
    setDropIndex(null);
  };

  const commitReorder = (targetIndex: number) => {
    const dragged = draggingId;
    endDrag();
    if (!bridges || dragged === null) return;

    const newIds = reorderedBridgeIds(bridges, dragged, targetIndex);
    const currentIds = bridges.map((b) => b.id);
    if (newIds.every((id, i) => id === currentIds[i])) return; // dropped back in place

    const byId = new Map(bridges.map((b) => [b.id, b]));
    const previous = bridges;
    setReorderError(null);
    reorderingRef.current = true;
    setBridges(newIds.map((id) => byId.get(id)!));
    api
      .reorderBridges(newIds)
      .catch((err: unknown) => {
        setBridges(previous);
        setReorderError(err instanceof ApiError ? err.message : "Could not save the new order");
      })
      .finally(() => {
        reorderingRef.current = false;
      });
  };

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
        <div
          // Container-level fallback for the two drag targets no individual
          // row's own onDragOver can claim: dropping below the last row, or
          // (with only one bridge) dropping back onto empty space — mirrors
          // WorkspaceSwitcher.tsx's WorkspaceList's own container handler.
          onDragOver={(e: DragEvent<HTMLDivElement>) => {
            if (draggingId === null) return;
            e.preventDefault();
            const nonDraggedCount = bridges.filter((b) => b.id !== draggingId).length;
            setDropIndex(nonDraggedCount);
          }}
          onDrop={(e: DragEvent<HTMLDivElement>) => {
            if (draggingId === null) return;
            e.preventDefault();
            const nonDraggedCount = bridges.filter((b) => b.id !== draggingId).length;
            commitReorder(dropIndex ?? nonDraggedCount);
          }}
        >
          <StyledList>
            {bridges.map((bridge) => {
              const isDragging = draggingId === bridge.id;
              // "Index within this list, excluding the dragged item" —
              // what reorderedBridgeIds/computeReorder expects as
              // targetIndex, same convention WorkspaceList.tsx uses for
              // the identical reason (its own comment on that function).
              const nonDraggedIds = bridges.filter((b) => b.id !== draggingId).map((b) => b.id);
              const idx = isDragging ? nonDraggedIds.length : nonDraggedIds.indexOf(bridge.id);
              const showIndicator = draggingId !== null && !isDragging && dropIndex === idx;

              return (
                <div
                  key={bridge.id}
                  onDragOver={
                    isDragging
                      ? undefined
                      : (e: DragEvent<HTMLDivElement>) => {
                          if (draggingId === null) return;
                          e.preventDefault();
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          const before = e.clientY < rect.top + rect.height / 2;
                          setDropIndex(before ? idx : idx + 1);
                        }
                  }
                  onDrop={
                    isDragging
                      ? undefined
                      : (e: DragEvent<HTMLDivElement>) => {
                          if (draggingId === null) return;
                          e.preventDefault();
                          e.stopPropagation();
                          commitReorder(dropIndex ?? idx);
                        }
                  }
                >
                  {showIndicator && <div className="ws-drop-indicator" />}
                  <ListRow
                    testId={`bridge-row-${bridge.id}`}
                    icon={
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span
                          className="ws-drag-handle"
                          draggable
                          title="Drag to reorder"
                          onDragStart={(e: DragEvent<HTMLSpanElement>) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", bridge.id);
                            startDrag(bridge.id);
                          }}
                          onDragEnd={endDrag}
                        >
                          <GripIcon size={13} />
                        </span>
                        <HostsIcon size={15} />
                      </span>
                    }
                    dot={bridge.connected ? "on" : "off"}
                    title={bridge.name ?? "unnamed helper"}
                    subtitle={bridge.platform ?? undefined}
                    trailing={
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 10.5, color: "var(--dim)" }}>
                          {describeBridge(bridge)}
                        </span>
                        <ConfirmButton
                          title={`Revoke ${bridge.name ?? "this bridge"} — every session on every enrolled host loses its SSH agent forwarding immediately`}
                          onConfirm={() => revoke(bridge)}
                          disabled={revoking[bridge.id] ?? false}
                        >
                          Revoke
                        </ConfirmButton>
                      </div>
                    }
                  />
                </div>
              );
            })}
          </StyledList>
        </div>
      )}
      {revokeError && <ErrorText style={{ marginTop: 8 }}>{revokeError}</ErrorText>}
      {reorderError && <ErrorText style={{ marginTop: 8 }}>{reorderError}</ErrorText>}

      <div style={{ marginTop: 10 }}>
        <AddButton onClick={() => setPairOpen(true)}>
          <PlusIcon size={13} />
          Pair a new bridge
        </AddButton>
      </div>

      {bridges !== null && bridges.length === 0 && loadError && (
        <ErrorText style={{ marginTop: 10 }}>Couldn't load SSH agent bridges.</ErrorText>
      )}
      {bridges !== null && bridges.length === 0 && !loadError && (
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
