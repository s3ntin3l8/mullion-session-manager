// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RightRail } from "./RightRail.js";
import { DESKTOP_NARROW_BAND_QUERY } from "../lib/layoutTier.js";
import { useDashboardStore } from "../store/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { ServerInfo, Session } from "../api/index.js";

// The rail's Browser icon from 1100px (#3403): which target it hands the
// opener, by what the server said about BROWSER_ENABLED.

const SESSION = { id: 7, projectId: 1 } as Session;
let serverInfo: ServerInfo | null = null;

vi.mock("../settings/useServerInfo.js", () => ({ useServerInfo: () => serverInfo }));
vi.mock("../hooks/useFollowedSession.js", () => ({ useFollowedSession: () => SESSION }));

beforeEach(() => {
  serverInfo = null;
  useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS, layoutMode: "auto" } });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === DESKTOP_NARROW_BAND_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function click(onOpenBrowser?: (projectId: number, session: Session | null) => void) {
  render(<RightRail projectId={1} onOpenBrowser={onOpenBrowser} />);
  const btn = screen.getByRole("button", { name: "Browser" });
  await userEvent.click(btn);
  return btn;
}

describe("RightRail Browser icon from 1100px", () => {
  it("opens the followed session's browser when the server has it on", async () => {
    serverInfo = { features: { browser: true } } as ServerInfo;
    const onOpenBrowser = vi.fn();
    await click(onOpenBrowser);
    expect(onOpenBrowser).toHaveBeenCalledWith(1, SESSION);
  });

  it("still opens the session's browser before the server has answered", async () => {
    const onOpenBrowser = vi.fn();
    await click(onOpenBrowser);
    expect(onOpenBrowser).toHaveBeenCalledWith(1, SESSION);
  });

  it("opens the preview only when the server says the browser is off", async () => {
    serverInfo = { features: { browser: false } } as ServerInfo;
    const onOpenBrowser = vi.fn();
    await click(onOpenBrowser);
    expect(onOpenBrowser).toHaveBeenCalledWith(1, null);
  });

  it("is disabled without an opener", async () => {
    expect(await click()).toBeDisabled();
  });
});
