import { useState } from "react";
import { useDashboardStore, LIVE_REFRESH_INTERVAL_MS } from "../../store/index.js";
import { api, ApiError, LOCAL_HOST_ID } from "../../api/index.js";
import type { Host, HostUpdateStatus } from "../../api/index.js";
import { CreateHostModal } from "../../CreateHostModal.js";
import { HostConfigModal } from "../../HostConfigModal.js";
import { deriveHostStatus, type PingState } from "../../hostStatus.js";
import { KebabMenu } from "../../ui/KebabMenu.js";
import { usePolling } from "../../hooks/usePolling.js";
import { CloseIcon, GearIcon, HostsIcon, PlusIcon, RenameIcon } from "../../ui/icons.js";
import { GroupHeading, ListRow, SecondaryButton, StyledList } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { BridgesSection } from "./BridgesSection.js";

// Issue #647 / roadmap 7.8 — separate from ServerInfoSection's own
// UPDATE_STATUS_POLL_MS (2000ms), which only gates the primary's own
// single global updater; N hosts need their own keyed poll, not a shared
// flat useState (same reasoning pingStatus below already follows).
const HOST_UPDATE_POLL_MS = 2000;

// Mirrors the backend's IN_FLIGHT_PHASES (src/services/update-apply.ts) —
// used only to recognize "an update is already running on this host" from a
// freshly-fetched status (e.g. after a page reload mid-update), not to
// duplicate any backend logic.
const HOST_UPDATE_IN_FLIGHT_PHASES = new Set([
  "downloading",
  "installing",
  "verifying",
  "restarting",
]);

export function HostsSection() {
  const { hosts, refreshHosts, createHost, updateHost, deleteHost, pingHost } = useDashboardStore();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [viewingConfig, setViewingConfig] = useState<{ id: string; name: string } | null>(null);
  const [pingStatus, setPingStatus] = useState<Record<string, PingState>>({});
  // A host that 409s on delete (still owns projects) — offers a cascade
  // retry inline instead of a second confirm dialog, since the backend's
  // own error message already names the project count.
  const [cascadePrompt, setCascadePrompt] = useState<{ id: string; message: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Issue #647 / roadmap 7.8 — per-host update state, keyed like pingStatus
  // above (one global updater's worth of state, per host, not a single flat
  // useState the way ServerInfoSection's UpdatesSubsection gets away with
  // for the primary).
  const [updateInfo, setUpdateInfo] = useState<Record<string, HostUpdateStatus>>({});
  const [applyingUpdate, setApplyingUpdate] = useState<Record<string, boolean>>({});
  const [applyError, setApplyError] = useState<Record<string, string>>({});

  const refreshHostUpdate = (hostId: string) => {
    api
      .getHostUpdateStatus(hostId)
      .then((info) => {
        setUpdateInfo((prev) => ({ ...prev, [hostId]: info }));
        // Recognizes an update already in flight on this host (e.g. this
        // tab reloaded mid-update, or a different tab started it) so the
        // poll effect below picks it up instead of the row looking idle.
        if (HOST_UPDATE_IN_FLIGHT_PHASES.has(info.status.phase)) {
          setApplyingUpdate((prev) => (prev[hostId] ? prev : { ...prev, [hostId]: true }));
        }
      })
      .catch(() => {
        // A failed fetch (host unreachable, old build) just means no
        // version/update UI renders for this row — the health dot already
        // communicates connectivity, no need for a second error surface.
      });
  };

  // Fetches each remote host's update status once the row appears — not on
  // every LIVE_REFRESH_INTERVAL_MS (4s) tick below, which would mean a
  // proxied round-trip to every agent every few seconds just to render a
  // version label. Re-runs when the set of remote host ids changes (a host
  // added/removed), keyed on a joined id string so it doesn't re-fire on
  // every unrelated `hosts` field update (e.g. the 4s health-dot refresh).
  const remoteHostIds = hosts
    .filter((h) => h.id !== LOCAL_HOST_ID)
    .map((h) => h.id)
    .join(",");
  usePolling(
    () => {
      for (const id of remoteHostIds.split(",").filter(Boolean)) {
        // Independent review — a host currently applying is owned by the
        // in-flight poll below instead. Without this, an in-flight
        // response from THIS 4s loop can land after that 2s loop has
        // already observed a terminal "done"/"failed" phase, overwriting
        // updateInfo back to an earlier phase and re-arming the in-flight
        // UI for an update that already finished.
        if (applyingUpdate[id]) continue;
        refreshHostUpdate(id);
      }
    },
    LIVE_REFRESH_INTERVAL_MS,
    { deps: [remoteHostIds], enabled: remoteHostIds.length > 0, pauseWhenHidden: true },
  );

  // Polls only the hosts with an update actually running — same
  // poll-until-terminal-state shape as ServerInfoSection's own update-apply
  // poll, just fanned out per host. A transient poll failure (expected
  // during the agent's own restart step — see self-update.sh's last step)
  // is swallowed on purpose: the row keeps showing its last known phase
  // ("restarting…") rather than flashing an error for a connectivity gap
  // that's part of a normal update.
  const applyingHostIds = Object.keys(applyingUpdate).filter((id) => applyingUpdate[id]);
  usePolling(
    () => {
      for (const id of applyingHostIds) {
        api
          .getHostUpdateStatus(id)
          .then((info) => {
            setUpdateInfo((prev) => ({ ...prev, [id]: info }));
            if (info.status.phase === "done" || info.status.phase === "failed") {
              setApplyingUpdate((prev) => ({ ...prev, [id]: false }));
            }
          })
          .catch(() => {
            // See comment above — a mid-restart connectivity gap is
            // expected, not a failure.
          });
      }
    },
    HOST_UPDATE_POLL_MS,
    { enabled: applyingHostIds.length > 0, immediate: false },
  );

  const applyHostUpdate = (hostId: string) => {
    setApplyError((prev) => {
      if (!(hostId in prev)) return prev;
      const next = { ...prev };
      delete next[hostId];
      return next;
    });
    setApplyingUpdate((prev) => ({ ...prev, [hostId]: true }));
    api
      .applyHostUpdate(hostId)
      .then((status) => {
        setUpdateInfo((prev) =>
          prev[hostId] ? { ...prev, [hostId]: { ...prev[hostId], status } } : prev,
        );
      })
      .catch((err: unknown) => {
        setApplyingUpdate((prev) => ({ ...prev, [hostId]: false }));
        setApplyError((prev) => ({
          ...prev,
          [hostId]: err instanceof ApiError ? err.message : "Could not start the update",
        }));
      });
  };

  // Sidebar.tsx's own mount effect already fetches `hosts` in practice
  // (it's always mounted alongside Settings), but relying on that as a
  // hidden cross-file invariant is fragile — a lone Settings render (or a
  // future change to when Sidebar mounts) would otherwise show a stale
  // list until the next mutation. This fetch is cheap; the duplication is
  // an acceptable cost for not coupling this section's correctness to
  // another file's mount order (Hermes review, PR #35).
  //
  // Also polls on LIVE_REFRESH_INTERVAL_MS (same interval GitPanel's own
  // live-status effect uses) so the heartbeat-driven health dot (issue
  // #246) actually updates while this section stays open, instead of only
  // on mount/after a host mutation — matching #246's "continuously-updated
  // indicator" ask, not just a one-shot fetch.
  usePolling(() => void refreshHosts(), LIVE_REFRESH_INTERVAL_MS, {
    pauseWhenHidden: true,
    deps: [refreshHosts],
  });

  // Snapshotting host.lastCheckedAt when the click *begins* (not when it
  // resolves) is what deriveHostStatus compares against later — see its
  // own doc comment for why this must be a server-issued value, never
  // Date.now().
  const testConnection = (host: Host) => {
    const lastCheckedAtSnapshot = host.lastCheckedAt;
    setPingStatus((prev) => ({
      ...prev,
      [host.id]: { status: "checking", lastCheckedAtSnapshot },
    }));
    void pingHost(host.id)
      .then((online) =>
        setPingStatus((prev) => ({
          ...prev,
          [host.id]: { status: online ? "online" : "offline", lastCheckedAtSnapshot },
        })),
      )
      .catch(() =>
        setPingStatus((prev) => ({
          ...prev,
          [host.id]: { status: "offline", lastCheckedAtSnapshot },
        })),
      );
  };

  const handleDelete = (host: Host) => {
    setDeleteError(null);
    void deleteHost(host.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // 409 is src/routes/hosts.ts's HostHasProjectsError (still owns
      // projects) — branching on the status code rather than matching the
      // message text ("...pass ?cascade=true") keeps this from silently
      // breaking if that wording ever changes; anything else (unreachable,
      // 404) surfaces as a plain inline error instead.
      if (err instanceof ApiError && err.statusCode === 409) {
        setCascadePrompt({ id: host.id, message });
      } else {
        setDeleteError(message);
      }
    });
  };

  const confirmCascadeDelete = () => {
    if (!cascadePrompt) return;
    const { id } = cascadePrompt;
    setCascadePrompt(null);
    void deleteHost(id, { cascade: true }).catch((err: unknown) => {
      setDeleteError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <>
      <GroupHeading
        title="Registered hosts"
        desc="Remote Mullion agents this dashboard can proxy sessions to."
      />
      <StyledList>
        <ListRow
          icon={<HostsIcon size={15} />}
          dot="on"
          title="This machine"
          subtitle="local"
          trailing={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10.5, color: "var(--dim)" }}>always online</span>
              <SecondaryButton
                onClick={() => setViewingConfig({ id: LOCAL_HOST_ID, name: "This machine" })}
              >
                Config
              </SecondaryButton>
            </div>
          }
        />
        {hosts
          .filter((h) => h.id !== LOCAL_HOST_ID)
          .map((host) => {
            const click = pingStatus[host.id] ?? { status: "unknown", lastCheckedAtSnapshot: null };
            const display = deriveHostStatus(host, click);
            return (
              <ListRow
                key={host.id}
                testId={`host-row-${host.id}`}
                icon={<HostsIcon size={15} />}
                dot={display.dot}
                title={host.name}
                subtitle={host.baseUrl ?? ""}
                trailing={
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {display.label && (
                      <span style={{ fontSize: 10.5, color: display.color }}>{display.label}</span>
                    )}
                    {(() => {
                      const info = updateInfo[host.id];
                      if (!info) return null;
                      const applying = applyingUpdate[host.id] ?? false;
                      if (info.upToDate) {
                        return (
                          <span style={{ fontSize: 10.5, color: "var(--dim)" }}>
                            v{info.hostVersion} · up to date
                          </span>
                        );
                      }
                      return (
                        <>
                          <span style={{ fontSize: 10.5, color: "var(--y)" }}>
                            v{info.hostVersion} → v{info.primaryVersion}
                          </span>
                          {info.updatable ? (
                            <SecondaryButton
                              onClick={() => applyHostUpdate(host.id)}
                              disabled={applying}
                            >
                              {applying ? `${info.status.phase}…` : "Update"}
                            </SecondaryButton>
                          ) : (
                            info.unavailableReason && (
                              <span
                                style={{ fontSize: 10.5, color: "var(--dim)" }}
                                title={info.unavailableReason}
                              >
                                update unavailable
                              </span>
                            )
                          )}
                        </>
                      );
                    })()}
                    <SecondaryButton
                      onClick={() => testConnection(host)}
                      disabled={click.status === "checking"}
                    >
                      Test
                    </SecondaryButton>
                    <KebabMenu
                      title="More…"
                      items={[
                        {
                          key: "config",
                          label: "View config",
                          icon: <GearIcon size={14} style={{ color: "var(--muted)" }} />,
                          onClick: () => setViewingConfig({ id: host.id, name: host.name }),
                        },
                        {
                          key: "edit",
                          label: "Edit",
                          icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                          onClick: () => setEditing(host),
                        },
                        {
                          key: "delete",
                          label: "Delete host",
                          armLabel: "Click again to delete",
                          icon: <CloseIcon size={14} />,
                          danger: true,
                          confirm: true,
                          onClick: () => handleDelete(host),
                        },
                      ]}
                    />
                  </div>
                }
              />
            );
          })}
      </StyledList>

      {cascadePrompt && (
        <div className="settings-cascade-warning">
          <span>{cascadePrompt.message}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <SecondaryButton onClick={confirmCascadeDelete}>
              Delete host and its projects
            </SecondaryButton>
            <SecondaryButton onClick={() => setCascadePrompt(null)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
      {deleteError && !cascadePrompt && (
        <ErrorText style={{ marginTop: 8 }}>{deleteError}</ErrorText>
      )}

      {Object.entries(applyError).map(([hostId, message]) => (
        <ErrorText key={hostId} style={{ marginTop: 8 }}>
          {hosts.find((h) => h.id === hostId)?.name ?? hostId}: {message}
        </ErrorText>
      ))}

      <div style={{ marginTop: 10 }}>
        <button className="settings-add-btn" onClick={() => setAddOpen(true)}>
          <PlusIcon size={13} />
          Add a host
        </button>
      </div>

      {hosts.filter((h) => h.id !== LOCAL_HOST_ID).length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>
          No remote hosts registered — every project runs on this machine until you add one.
        </div>
      )}

      {addOpen && (
        <CreateHostModal
          onClose={() => setAddOpen(false)}
          onSave={(name, baseUrl, token) => createHost(name, baseUrl, token)}
        />
      )}
      {editing && (
        <CreateHostModal
          mode="edit"
          initialName={editing.name}
          initialBaseUrl={editing.baseUrl ?? ""}
          hasToken={editing.hasToken}
          onClose={() => setEditing(null)}
          onSave={(name, baseUrl, token) =>
            updateHost(editing.id, token ? { name, baseUrl, token } : { name, baseUrl })
          }
        />
      )}
      {viewingConfig && (
        <HostConfigModal
          hostId={viewingConfig.id}
          hostName={viewingConfig.name}
          onClose={() => setViewingConfig(null)}
        />
      )}

      <div style={{ marginTop: 28 }}>
        <BridgesSection />
      </div>
    </>
  );
}
