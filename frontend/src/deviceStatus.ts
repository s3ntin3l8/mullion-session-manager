import type { Device } from "./api/index.js";

// Shared by SidebarDevices.tsx and settings/sections/DevicesSection.tsx
// (self-review, code-review high — was duplicated near-verbatim in both)
// so the two surfaces can never disagree on what a device's status dot
// means. Handles `status: "killed"` explicitly rather than relying on a
// caller to have already filtered it out: a killed row is a STOPPED device,
// and both surfaces render those now (the sidebar dimmed with a Start
// control, Settings with the full lifecycle) — only DELETE drops a row, and
// then it's gone from both.
export function deviceDotClass(device: Device): "on" | "off" | "warn" {
  if (device.status === "killed") return "off";
  switch (device.live?.status) {
    case "streaming":
      return "on";
    case "starting":
    case "booting":
      return "warn";
    default:
      return "off";
  }
}
