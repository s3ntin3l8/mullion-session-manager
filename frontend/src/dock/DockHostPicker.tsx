import { useState } from "react";
import { api } from "../api/index.js";
import { OWN_HOST_VALUE } from "../command-palette/hostTarget.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { Dropdown } from "../ui/primitives.js";
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

/**
 * Where this project's dock controls start (#3425): the project's own host, or
 * another host it has a checkout on (e.g. a Mac agent). A per-launch choice
 * held in the dock, never stored; the dock rows' Start sends it.
 *
 * #3556 — it picks the NEXT start's host, so while a control runs it shows the
 * host that control is on and is locked: a different choice would say one host
 * while the log pane shows another. Stopping the control unlocks it.
 */
export function DockHostPicker({ picker }: { picker: DockHostPickerState }) {
  const locked = picker.lockedBy.length > 0;
  const elsewhere = picker.value !== OWN_HOST_VALUE;
  const hostName = picker.options.find((o) => o.value === picker.value)?.label ?? picker.value;
  const title = lockTitle(picker.lockedBy, hostName);
  // Previews are what carries another host's dev server into the browser pane;
  // without PREVIEW_BASE_HOST the pane would open the URL on this machine.
  const [previewsOff, setPreviewsOff] = useState(false);
  useAsyncData(
    () => api.getServerInfo(),
    (info) => setPreviewsOff(!info.previewsEnabled),
    () => setPreviewsOff(false),
    [elsewhere],
    { enabled: elsewhere },
  );
  return (
    // The title sits on the wrapper too: a disabled field does not reliably
    // show its own tooltip on hover.
    <div className="dock-host-picker" title={title}>
      <span className="dock-host-picker-label">{locked ? "Running on" : "Next start on"}</span>
      <Dropdown
        // The lock's reason is part of the name: a disabled field's tooltip
        // is not announced.
        ariaLabel={locked ? `Run dock controls on host — ${title}` : "Run dock controls on host"}
        value={picker.value}
        onChange={picker.onChange}
        options={picker.options}
        disabled={locked}
        title={title}
      />
      {elsewhere && previewsOff && (
        <span className="dock-host-picker-hint" role="note">
          Previews are off (PREVIEW_BASE_HOST is not set), so this dev server will not open in the
          browser pane.
        </span>
      )}
    </div>
  );
}
