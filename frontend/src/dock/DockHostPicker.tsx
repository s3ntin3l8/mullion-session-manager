import { useState } from "react";
import { api } from "../api/index.js";
import { OWN_HOST_VALUE } from "../command-palette/hostTarget.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { Dropdown } from "../ui/primitives.js";
import { useTooltip } from "../ui/sidebar/useTooltip.js";
import type { DockHostPicker as DockHostPickerState } from "./useDockProject.js";

/** The selector's tooltip: what it does now, and how to change it. */
function lockTitle(lockedBy: readonly string[], hostName: string): string {
  if (lockedBy.length === 0)
    return "Where the next Start runs: that host's checkout of the project, with its own .env.";
  if (lockedBy.length === 1)
    return `${lockedBy[0]} is running on ${hostName}. Stop ${lockedBy[0]} to run it on another host.`;
  const names = `${lockedBy.slice(0, -1).join(", ")} and ${lockedBy[lockedBy.length - 1]}`;
  return `${names} are running. Stop them to run them on another host.`;
}

function hostNameOf(picker: DockHostPickerState): string {
  return picker.options.find((o) => o.value === picker.value)?.label ?? picker.value;
}

/**
 * Where this project's dock controls start (#3425): the project's own host, or
 * another host it has a checkout on (e.g. a Mac agent). A per-launch choice
 * held in the dock, never stored; the dock rows' Start sends it.
 *
 * #3556 — it picks the NEXT start's host, so while a control runs it shows the
 * host that control is on and is locked: a different choice would say one host
 * while the log pane shows another. Stopping the control unlocks it.
 *
 * #3589 — one label in both states ("Run on"); while locked the field shows
 * the running host (each row carries its own "on <host>" badge, #3560). Its
 * tooltip is the shared portaled bubble, so the Dock's own overflow cannot
 * clip it.
 */
export function DockHostPicker({ picker }: { picker: DockHostPickerState }) {
  const locked = picker.lockedBy.length > 0;
  const hostName = hostNameOf(picker);
  const title = lockTitle(picker.lockedBy, hostName);
  const { setAnchor, triggerProps, tooltip } = useTooltip<HTMLDivElement>(title);
  return (
    // The tooltip hangs off the wrapper: a disabled field does not reliably
    // report its own hover.
    <div className="dock-host-picker" ref={setAnchor} {...triggerProps}>
      <span className="dock-host-picker-label">Run on</span>
      <Dropdown
        // The lock's reason is part of the name: a tooltip is not announced.
        ariaLabel={locked ? `Run dock controls on host — ${title}` : "Run dock controls on host"}
        value={picker.value}
        onChange={picker.onChange}
        options={picker.options}
        disabled={locked}
        small
      />
      {tooltip}
    </div>
  );
}

/**
 * Previews are what carries another host's dev server into the browser pane;
 * without PREVIEW_BASE_HOST the pane would open the URL on this machine. A line
 * of its own under the Dock's project header (#3589): inside the header it
 * wrapped the header onto several rows.
 */
export function DockPreviewsOffNote({ picker }: { picker: DockHostPickerState }) {
  const elsewhere = picker.value !== OWN_HOST_VALUE;
  const [previewsOff, setPreviewsOff] = useState(false);
  useAsyncData(
    () => api.getServerInfo(),
    (info) => setPreviewsOff(!info.previewsEnabled),
    () => setPreviewsOff(false),
    [elsewhere],
    { enabled: elsewhere },
  );
  if (!elsewhere || !previewsOff) return null;
  return (
    <span className="dock-host-picker-hint" role="note">
      Previews are off (PREVIEW_BASE_HOST is not set), so this dev server will not open in the
      browser pane.
    </span>
  );
}
