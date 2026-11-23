import { useState } from "react";
import { api } from "../api/index.js";
import { OWN_HOST_VALUE } from "../command-palette/hostTarget.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { Dropdown } from "../ui/primitives.js";
import type { DockHostPicker as DockHostPickerState } from "./useDockProject.js";

/**
 * Where this project's dock controls start (#3425): the project's own host, or
 * another host it has a checkout on (e.g. a Mac agent). A per-launch choice
 * held in the dock, never stored; the dock rows' Start sends it.
 */
export function DockHostPicker({ picker }: { picker: DockHostPickerState }) {
  const elsewhere = picker.value !== OWN_HOST_VALUE;
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
    <div className="dock-host-picker">
      <span className="dock-host-picker-label">Run on</span>
      <Dropdown
        ariaLabel="Run dock controls on host"
        value={picker.value}
        onChange={picker.onChange}
        options={picker.options}
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
