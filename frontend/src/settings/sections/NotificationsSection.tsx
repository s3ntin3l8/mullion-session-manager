import { Fragment, useEffect, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { api } from "../../api/index.js";
import type { Agent, SessionStatus, SoundName } from "../../api/index.js";
import { requestNotificationPermission } from "../../desktopNotify.js";
import { disablePush, enablePush, isPushSupported } from "../../pushClient.js";
import { STATUS_PRESENTATION, isStatusReachable } from "../../sessionStatus.js";
import { BellIcon } from "../../ui/icons.js";
import {
  Dropdown,
  GroupHeading,
  ListRow,
  Row,
  Slider,
  StyledList,
  Toggle,
} from "../../ui/primitives.js";

const SOUND_OPTIONS: Array<{ value: SoundName; label: string }> = [
  { value: "ping", label: "Ping" },
  { value: "chime", label: "Chime" },
  { value: "blip", label: "Blip" },
];

export function NotificationsSection() {
  const { settings, updateSettings } = useDashboardStore();
  const n = settings.notifications;
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const pushSupported = isPushSupported();

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch(() => {});
  }, []);

  const agentEmitsUnion: readonly string[] = [...new Set((agents ?? []).flatMap((a) => a.emits))];
  const reachableStatuses = (Object.keys(STATUS_PRESENTATION) as SessionStatus[]).filter((s) =>
    isStatusReachable(s, agentEmitsUnion),
  );

  const statusGroups: Array<{ label: string; statuses: SessionStatus[] }> = [
    { label: "Errors", statuses: ["api_error", "tool_failure"] },
    {
      label: "Blocked",
      statuses: [
        "awaiting_permission",
        "awaiting_plan",
        "awaiting_review_gate",
        "awaiting_promote",
        "awaiting_question",
        "awaiting_elicitation",
      ],
    },
    { label: "Turn complete", statuses: ["finished"] },
    { label: "Needs attention", statuses: ["needs_input"] },
    { label: "Busy", statuses: ["compacting", "subagent", "background", "working"] },
    { label: "Dormant", statuses: ["idle", "exited"] },
  ];

  return (
    <>
      <Row
        label="Browser permission"
        desc="If denied, allow notifications in your browser's site settings."
      >
        <span className="settings-readonly-value">{permission}</span>
      </Row>

      <div style={{ paddingTop: 6 }}>
        <GroupHeading title="Delivery channels" />
        <StyledList>
          <ListRow
            icon={<BellIcon size={16} />}
            title="Browser notification"
            trailing={
              <Toggle
                size="small"
                testId="notif-browser-channel-toggle"
                on={n.channels.browser}
                onChange={(v) => {
                  updateSettings({ notifications: { channels: { browser: v } } });
                  if (
                    v &&
                    typeof Notification !== "undefined" &&
                    Notification.permission === "default"
                  ) {
                    requestNotificationPermission(setPermission);
                  }
                }}
              />
            }
          />
          <ListRow
            icon={<BellIcon size={16} />}
            title="Sound"
            trailing={
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Dropdown
                  small
                  value={n.soundName}
                  onChange={(v) => updateSettings({ notifications: { soundName: v } })}
                  options={SOUND_OPTIONS}
                />
                <Toggle
                  size="small"
                  on={n.channels.sound}
                  onChange={(v) => updateSettings({ notifications: { channels: { sound: v } } })}
                />
              </div>
            }
          />
          <ListRow
            icon={<BellIcon size={16} />}
            title="Push notification"
            unavailable={!pushSupported}
            subtitle={
              !pushSupported
                ? "Not supported in this browser. Requires HTTPS and push support."
                : (pushError ?? undefined)
            }
            trailing={
              <Toggle
                size="small"
                testId="notif-push-channel-toggle"
                disabled={!pushSupported || pushBusy}
                on={n.channels.push}
                onChange={(v) => {
                  setPushError(null);
                  // Optimistic — flip the setting immediately so the toggle
                  // doesn't feel unresponsive during the subscribe/
                  // unsubscribe round trip, then revert it if that fails
                  // (below) so the toggle never lies about whether a real
                  // subscription exists.
                  updateSettings({ notifications: { channels: { push: v } } });
                  setPushBusy(true);
                  const settle = v ? enablePush() : disablePush();
                  settle
                    .catch((err) => {
                      updateSettings({ notifications: { channels: { push: !v } } });
                      setPushError(err instanceof Error ? err.message : "Failed to subscribe.");
                    })
                    .finally(() => setPushBusy(false));
                }}
              />
            }
          />
        </StyledList>
      </div>

      <div style={{ paddingTop: 12 }}>
        <GroupHeading
          title="Status notifications"
          desc="Choose which session states notify you, play a sound, or focus the session. Only states your installed agents report are shown."
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px, 1fr) 60px 60px 60px",
            gap: "6px 8px",
            alignItems: "center",
            fontSize: 11,
          }}
        >
          <div /> {/* empty label column */}
          <div style={{ textAlign: "center", color: "var(--dim)" }}>Notify</div>
          <div style={{ textAlign: "center", color: "var(--dim)" }}>Sound</div>
          <div style={{ textAlign: "center", color: "var(--dim)" }}>Focus</div>
          {statusGroups.map((group) => {
            const filtered = group.statuses.filter((s) => reachableStatuses.includes(s));
            if (filtered.length === 0) return null;
            return (
              <Fragment key={group.label}>
                <div
                  style={{
                    gridColumn: "1 / -1",
                    fontSize: 10,
                    color: "var(--muted)",
                    paddingTop: 8,
                    paddingBottom: 2,
                    fontWeight: 500,
                  }}
                >
                  {group.label}
                </div>
                {filtered.map((status) => {
                  const pres = STATUS_PRESENTATION[status];
                  const matrix = n.notificationMatrix?.[status] ?? {
                    notify: false,
                    sound: false,
                    autoFocus: false,
                  };
                  return (
                    <Fragment key={status}>
                      <div
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {pres.label}
                      </div>
                      <Toggle
                        size="small"
                        testId={`notif-matrix-${status}-notify`}
                        on={matrix.notify}
                        onChange={(v) =>
                          updateSettings({
                            notifications: {
                              notificationMatrix: {
                                [status]: { ...matrix, notify: v },
                              },
                            },
                          })
                        }
                      />
                      <Toggle
                        size="small"
                        testId={`notif-matrix-${status}-sound`}
                        on={matrix.sound}
                        onChange={(v) =>
                          updateSettings({
                            notifications: {
                              notificationMatrix: {
                                [status]: { ...matrix, sound: v },
                              },
                            },
                          })
                        }
                      />
                      <Toggle
                        size="small"
                        testId={`notif-matrix-${status}-autoFocus`}
                        on={matrix.autoFocus}
                        onChange={(v) =>
                          updateSettings({
                            notifications: {
                              notificationMatrix: {
                                [status]: { ...matrix, autoFocus: v },
                              },
                            },
                          })
                        }
                      />
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
      </div>

      <Row label="Idle threshold" desc="How long a session must be quiet before it counts as idle.">
        <Slider
          min={5}
          max={120}
          step={5}
          value={n.idleThresholdSeconds}
          format={(v) => `${v}s`}
          onChange={(v) => updateSettings({ notifications: { idleThresholdSeconds: v } })}
        />
      </Row>
      <Row
        label="Auto-focus on attention"
        desc="Focus a session as soon as it needs your input. The Focus column above sets which states do this."
      >
        <Toggle
          on={n.autoFocusOnAttention}
          onChange={(v) => updateSettings({ notifications: { autoFocusOnAttention: v } })}
        />
      </Row>
    </>
  );
}
