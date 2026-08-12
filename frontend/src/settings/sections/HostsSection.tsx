import { useState } from "react";
import { useDashboardStore, LIVE_REFRESH_INTERVAL_MS } from "../../store/index.js";
import { ApiError, LOCAL_HOST_ID } from "../../api/index.js";
import type { Host } from "../../api/index.js";
import { CreateHostModal } from "../../CreateHostModal.js";
import { HostConfigModal } from "../../HostConfigModal.js";
import { deriveHostStatus, type PingState } from "../../hostStatus.js";
import { KebabMenu } from "../../ui/KebabMenu.js";
import { usePolling } from "../../hooks/usePolling.js";
import { CloseIcon, GearIcon, HostsIcon, PlusIcon, RenameIcon } from "../../ui/icons.js";
import { GroupHeading, ListRow, SecondaryButton, StyledList } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";

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
    </>
  );
}
