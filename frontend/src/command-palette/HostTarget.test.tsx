// @vitest-environment jsdom
// Issue #2237 — the launcher's host target chip, mounted inside the real
// <CommandPalette> (the launch() handler reads the choice at launch time).
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../CommandPalette.js";
import { useDashboardStore } from "../store/index.js";
import type { Launcher } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeHost, makeProject } from "../test/fixtures.js";
import { STORAGE_KEYS } from "../lib/persistedState.js";
import { buildHostTargetOptions, resolveHostChoice, describeAutoPreview } from "./hostTarget.js";

const LAUNCHER: Launcher = { id: "agent:bash", kind: "shell", title: "bash", command: "bash" };
const MAC = makeHost({ id: "mac", name: "Mac mini", health: "online" });
const OFFLINE = makeHost({ id: "gone", name: "Old box", health: "offline" });
const PARKED = makeHost({ id: "parked", name: "Parked box", health: "online", drained: true });
const OFFLINE_MAC = makeHost({ id: "mac", name: "Mac mini", health: "offline" });
const MULTI = makeProject({
  id: 5,
  hostId: "local",
  hostCwds: { mac: "/Users/x/p", gone: "/x", parked: "/y" },
});
const SINGLE = makeProject({ id: 6, name: "solo", hostId: "local", hostCwds: {} });

function renderPalette(projectId: number) {
  const props: ComponentProps<typeof CommandPalette> = {
    scope: "project",
    projectId,
    onClose: vi.fn(),
    onLaunched: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenGitHub: vi.fn(),
    onOpenAgentRules: vi.fn(),
    onOpenFileEditor: vi.fn(),
    onOpenExternalFile: vi.fn(),
    onOpenProjectBriefing: vi.fn(),
    onOpenProjectSetup: vi.fn(),
    onOpenDockConfig: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenBrowser: vi.fn(),
    onOpenBlankBrowser: vi.fn(),
    onOpenSettingsSection: vi.fn(),
    onOpenTasks: vi.fn(),
    onOpenBrowserUrl: vi.fn(),
  };
  return render(<CommandPalette {...props} />);
}

describe("CommandPalette -> launcher host target (#2237)", () => {
  let posted: Array<Record<string, unknown>>;

  beforeEach(() => {
    localStorage.clear();
    posted = [];
    useDashboardStore.setState({
      projects: [MULTI, SINGLE],
      sessions: [],
      hosts: [MAC, OFFLINE, PARKED],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
        if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
        if (url.includes("/placement-preview")) {
          return Promise.resolve(
            jsonResponse(200, {
              placement: "auto",
              hostId: "mac",
              reason: "lowest load",
              considered: [],
              excluded: [{ hostId: "gone", reason: "offline" }],
            }),
          );
        }
        if (url.includes("/git-branches")) return Promise.resolve(jsonResponse(200, {}));
        if (url.endsWith("/api/sessions") && init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return Promise.resolve(jsonResponse(201, { id: 1, projectId: 5, command: "bash" }));
        }
        if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an auto project defaults the chip to Auto and can still pick its own host", async () => {
    const AUTO = makeProject({
      id: 7,
      name: "autop",
      hostId: "local",
      placement: "auto",
      hostCwds: { mac: "/p" },
    });
    useDashboardStore.setState({ projects: [AUTO], hosts: [MAC] });
    const user = userEvent.setup();
    renderPalette(AUTO.id);
    const select = (await screen.findByLabelText("Target host")) as HTMLSelectElement;
    expect(select.value).toBe("auto");
    await user.selectOptions(select, "__own__");
    await user.click((await screen.findAllByText("bash"))[0]);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ targetHostId: "local" });
    expect(posted[0]).not.toHaveProperty("placement");
  });

  it("shows no chip for a single-host project", async () => {
    renderPalette(SINGLE.id);
    await screen.findAllByText("bash");
    expect(screen.queryByLabelText("Target host")).toBeNull();
  });

  it("lists this server, each host and Auto, with unavailable hosts disabled", async () => {
    renderPalette(MULTI.id);
    const select = (await screen.findByLabelText("Target host")) as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => [o.textContent, o.disabled]);
    expect(opts).toEqual([
      ["this server", false],
      ["Mac mini", false],
      ["Old box (offline)", true],
      ["Parked box (parked)", true],
      ["Auto", false],
    ]);
    expect(select.value).toBe("__own__");
  });

  it("a no-interaction launch sends no host fields", async () => {
    const user = userEvent.setup();
    renderPalette(MULTI.id);
    await user.click((await screen.findAllByText("bash"))[0]);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).not.toHaveProperty("targetHostId");
    expect(posted[0]).not.toHaveProperty("placement");
  });

  it("choosing a host sends targetHostId, and the worktree toggle becomes isolate", async () => {
    const user = userEvent.setup();
    renderPalette(MULTI.id);
    await user.selectOptions(await screen.findByLabelText("Target host"), "mac");
    await user.click(screen.getByRole("checkbox", { name: /isolate in a new worktree/i }));
    expect(screen.getByText(/the host's default branch/)).toBeInTheDocument();
    await user.click((await screen.findAllByText("bash"))[0]);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ targetHostId: "mac", isolate: true });
    expect(posted[0]).not.toHaveProperty("worktree");
    expect(posted[0]).not.toHaveProperty("placement");
  });

  it("Auto sends placement and shows the preview with excluded hosts", async () => {
    const user = userEvent.setup();
    renderPalette(MULTI.id);
    await user.selectOptions(await screen.findByLabelText("Target host"), "auto");
    expect(await screen.findByText(/Mac mini: lowest load/)).toHaveTextContent(
      /not considered: Old box \(offline\)/,
    );
    await user.click((await screen.findAllByText("bash"))[0]);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ placement: "auto" });
    expect(posted[0]).not.toHaveProperty("targetHostId");
  });

  it("remembers the choice per project across a remount", async () => {
    const user = userEvent.setup();
    const first = renderPalette(MULTI.id);
    await user.selectOptions(await screen.findByLabelText("Target host"), "mac");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.lastLaunchHostByProject) ?? "{}")).toEqual({
      "5": "mac",
    });
    first.unmount();
    renderPalette(MULTI.id);
    expect(((await screen.findByLabelText("Target host")) as HTMLSelectElement).value).toBe("mac");
  });
});

describe("hostTarget helpers", () => {
  it("resolveHostChoice falls back to the default for a host no longer on the project", () => {
    const project = { hostId: "local", hostCwds: { mac: "/p" } };
    expect(resolveHostChoice("mac", project)).toBe("mac");
    expect(resolveHostChoice("auto", project)).toBe("auto");
    expect(resolveHostChoice("removed", project)).toBeNull();
    expect(resolveHostChoice("mac", project, [OFFLINE_MAC])).toBeNull();
    expect(resolveHostChoice("mac", project, [{ ...OFFLINE_MAC, health: "pending" }])).toBeNull();
    // An auto project defaults to Auto; its own host is an explicit choice.
    const auto = { ...project, placement: "auto" };
    expect(resolveHostChoice(undefined, auto)).toBe("auto");
    expect(resolveHostChoice("local", auto)).toBe("local");
    expect(resolveHostChoice("removed", auto)).toBe("auto");
    expect(resolveHostChoice("local", project)).toBeNull();
    expect(resolveHostChoice(undefined, project)).toBeNull();
  });

  it("names a remote own host instead of 'this server'", () => {
    const opts = buildHostTargetOptions({ hostId: "mac", hostCwds: { local: "/p" } }, [MAC]);
    expect(opts[0].label).toBe("Mac mini");
  });

  it("describeAutoPreview omits the excluded clause when nothing is excluded", () => {
    expect(
      describeAutoPreview(
        {
          placement: "auto",
          hostId: "x",
          reason: "r",
          considered: [],
          excluded: [],
          fellBack: false,
        },
        [],
      ),
    ).toBe("x: r");
  });
});

describe("project placement flags in the host chip (#2241)", () => {
  const LINUX = makeHost({ id: "lin", name: "Linux box", health: "online", platform: "linux" });
  const DARWIN = makeHost({ id: "mac", name: "Mac mini", health: "online", platform: "darwin" });
  const NOT_REPORTED = makeHost({ id: "new", name: "New box", health: "online", platform: null });
  const flagged = {
    hostId: "local",
    hostCwds: { lin: "/a", mac: "/b", new: "/c" },
    placementConstraints: { platform: ["darwin" as const], allowBurst: false },
  };

  it("disables a host the platform flag forbids, with the reason, and keeps the others", () => {
    const opts = buildHostTargetOptions(flagged, [LINUX, DARWIN, NOT_REPORTED]);
    expect(opts.find((o) => o.value === "lin")).toMatchObject({
      label: "Linux box (project allows only darwin hosts)",
      disabled: true,
    });
    expect(opts.find((o) => o.value === "mac")?.disabled).toBe(false);
    // Not reported yet: the server decides.
    expect(opts.find((o) => o.value === "new")?.disabled).toBe(false);
    expect(opts.find((o) => o.value === "auto")?.disabled).toBe(false);
  });

  it("disables the own host only where choosing it sends an explicit target (an auto project)", () => {
    const local = makeHost({ id: "local", name: "local", isLocal: true, platform: "linux" });
    const pinned = buildHostTargetOptions(flagged, [local, DARWIN]);
    expect(pinned[0]).toMatchObject({ label: "this server", disabled: false });
    const auto = buildHostTargetOptions({ ...flagged, placement: "auto" }, [local, DARWIN]);
    expect(auto[0]).toMatchObject({
      label: "this server (project allows only darwin hosts)",
      disabled: true,
    });
  });

  it("falls back when a remembered host is ruled out by a newly-set flag", () => {
    const project = {
      ...flagged,
      placement: "auto",
      placementConstraints: flagged.placementConstraints,
    };
    expect(resolveHostChoice("lin", project, [LINUX, DARWIN])).toBe("auto");
    expect(resolveHostChoice("mac", project, [LINUX, DARWIN])).toBe("mac");
  });

  it("changes nothing without flags, or with an empty platform list", () => {
    const base = { hostId: "local", hostCwds: { lin: "/a" } };
    expect(buildHostTargetOptions(base, [LINUX])[1].disabled).toBe(false);
    expect(
      buildHostTargetOptions(
        { ...base, placementConstraints: { platform: [], allowBurst: false } },
        [LINUX],
      )[1].disabled,
    ).toBe(false);
  });

  it("words a refused Auto preview without naming a host as the choice", () => {
    const text = describeAutoPreview(
      {
        placement: "auto",
        hostId: "local",
        reason: "no eligible host satisfies this project's placement flags — not placed",
        considered: [],
        excluded: [{ hostId: "lin", reason: "project allows only darwin hosts" }],
        fellBack: true,
        refusal: { detail: "x", transient: false },
      },
      [LINUX],
    );
    expect(text).toMatch(/^Auto cannot place this: no eligible host/);
    expect(text).toContain("Linux box (project allows only darwin hosts)");
  });
});
