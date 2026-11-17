// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiscoveredProject } from "../api/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";
import launcherProjectsCss from "../styles/launcher-projects.css?raw";
import { LauncherProjectView } from "./LauncherProjects.js";

// The rule body of the first `selector {…}` block in a stylesheet.
function rule(css: string, selector: string): string {
  // vitest.config.ts's css.include must list the stylesheet, or `?raw` is "".
  if (css === "")
    throw new Error("stylesheet loaded empty: add it to vitest.config.ts css.include");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

// #3212 — the Add/Edit project view sits in the launcher's body, a flex
// column that scrolls (modals.css's .create-modal-body). jsdom does no layout, so the
// rules that keep the form at its content height are pinned here; the
// overlap itself was checked in the demo (see the pull request).
describe("LauncherProjectView layout (#3212)", () => {
  it("the view and the form never shrink below their content", () => {
    for (const selector of [".launcher-project-view", ".embedded-form"]) {
      const body = rule(launcherProjectsCss, selector);
      expect(body, selector).toMatch(/flex-shrink:\s*0/);
      // min-height: 0 is what let the form collapse under the Discover list.
      expect(body, selector).not.toMatch(/min-height:\s*0/);
    }
  });

  it("the form's body takes its content height and does not scroll itself", () => {
    const body = rule(launcherProjectsCss, ".embedded-form-body");
    expect(body).toMatch(/flex:\s*none/);
    expect(body).toMatch(/overflow-y:\s*visible/);
  });
});

function repo(name: string, extra: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return { name, cwd: `/home/x/${name}`, isGitRepo: true, isRegistered: false, ...extra };
}

// #3244 — the Add project view leads with one row that opens the discovered
// repositories as their own view.
describe("LauncherProjectView: discovered repositories (#3244)", () => {
  let unexpectedCalls: string[] = [];
  let discoverCalls = 0;
  let created: Record<string, unknown>[] = [];

  function stub(found: DiscoveredProject[] | (() => Promise<Response>)) {
    discoverCalls = 0;
    created = [];
    const result = mockFetch({
      "GET /api/projects/discover": () => {
        discoverCalls++;
        return typeof found === "function" ? found() : jsonResponse(200, found);
      },
      "POST /api/projects": ({ init }) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        created.push(body);
        return jsonResponse(201, { id: 77, name: body.name, cwd: body.cwd });
      },
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/projects/placement-preview": () => jsonResponse(200, null),
    });
    unexpectedCalls = result.unexpectedCalls;
    vi.stubGlobal("fetch", result.fetchMock);
  }

  function renderAdd() {
    const onBack = vi.fn();
    const onAdded = vi.fn();
    render(<LauncherProjectView view={{ kind: "add" }} onBack={onBack} onAdded={onAdded} />);
    return { onBack, onAdded };
  }

  beforeEach(() => {
    resetStore({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });
  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("the row shows the count and the list is not in the Add view", async () => {
    stub([repo("atlas"), repo("beacon"), repo("done", { isRegistered: true })]);
    renderAdd();
    const form = screen.getByRole("group", { name: "Add project" });
    expect(
      await within(form).findByRole("button", { name: "Choose from 2 discovered repositories" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("atlas")).toBeNull();
    expect(screen.queryByText("Discover projects")).toBeNull();
  });

  it("says so while the scan runs, and one repository is singular", async () => {
    let release: (r: Response) => void = () => {};
    stub(() => new Promise<Response>((resolve) => (release = resolve)));
    renderAdd();
    expect(screen.getByText("Looking for repositories…")).toBeInTheDocument();
    release(jsonResponse(200, [repo("atlas")]));
    expect(
      await screen.findByRole("button", { name: "Choose from 1 discovered repository" }),
    ).toBeInTheDocument();
  });

  it("zero results shows the Settings hint instead of the row", async () => {
    stub([repo("done", { isRegistered: true })]);
    renderAdd();
    expect(await screen.findByText("No repositories found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Configure search roots" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /discovered repositor/ })).toBeNull();
  });

  it("opens the view, lists the repositories and filters them by name above eight", async () => {
    const names = [
      "atlas",
      "beacon",
      "comet",
      "delta",
      "ember",
      "fjord",
      "glade",
      "harbor",
      "iris",
    ];
    stub(names.map((n) => repo(n)));
    const user = userEvent.setup();
    renderAdd();
    await user.click(
      await screen.findByRole("button", { name: "Choose from 9 discovered repositories" }),
    );

    const view = screen.getByRole("group", { name: "Discovered repositories" });
    expect(screen.queryByRole("group", { name: "Add project" })).toBeNull();
    const list = within(view).getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(9);
    expect(within(list).getAllByText("git")).toHaveLength(9);
    const search = within(view).getByRole("searchbox", { name: "Search repositories" });
    expect(search).toHaveFocus();

    await user.type(search, "ar");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("harbor")]);
    await user.type(search, "zz");
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(view).getByText("No repository matches “arzz”.")).toBeInTheDocument();
    // One scan serves the row and the view.
    expect(discoverCalls).toBe(1);
  });

  it("eight or fewer have no search field", async () => {
    stub([repo("atlas"), repo("beacon")]);
    const user = userEvent.setup();
    renderAdd();
    await user.click(await screen.findByRole("button", { name: /Choose from 2/ }));
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("Add selects the project and returns to the launcher", async () => {
    stub([repo("atlas"), repo("beacon")]);
    const user = userEvent.setup();
    const { onAdded, onBack } = renderAdd();
    await user.click(await screen.findByRole("button", { name: /Choose from 2/ }));
    const row = screen.getByText("beacon").closest(".discover-item") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(77));
    expect(onBack).toHaveBeenCalled();
    expect(created[0]).toMatchObject({ name: "beacon", cwd: "/home/x/beacon" });
  });

  it("Back returns to the Add view with the form's values intact", async () => {
    stub([repo("atlas")]);
    const user = userEvent.setup();
    const { onBack } = renderAdd();
    const name = screen.getByRole("textbox", { name: /Display name/ });
    await user.type(name, "my-thing");
    await user.click(await screen.findByRole("button", { name: /Choose from 1/ }));
    const view = screen.getByRole("group", { name: "Discovered repositories" });
    await user.click(within(view).getByRole("button", { name: "Back" }));

    expect(screen.queryByRole("group", { name: "Discovered repositories" })).toBeNull();
    expect(screen.getByRole("textbox", { name: /Display name/ })).toHaveValue("my-thing");
    const rowButton = screen.getByRole("button", { name: /Choose from 1/ });
    await waitFor(() => expect(rowButton).toHaveFocus());
    expect(onBack).not.toHaveBeenCalled();
    expect(discoverCalls).toBe(1);
  });

  it("Escape in the discovered view goes back to the form, not out of the launcher", async () => {
    stub([repo("atlas")]);
    const user = userEvent.setup();
    const { onBack } = renderAdd();
    await user.click(await screen.findByRole("button", { name: /Choose from 1/ }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("group", { name: "Add project" })).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("Configure search roots closes the launcher and opens Settings → Projects", async () => {
    stub([]);
    const closeLauncher = vi.fn();
    useDashboardStore.setState({ closeLauncher });
    const user = userEvent.setup();
    renderAdd();
    await user.click(await screen.findByRole("button", { name: "Configure search roots" }));
    expect(closeLauncher).toHaveBeenCalled();
  });
});

describe("launcher discovered-view styles (#3244)", () => {
  it("the hidden form is not drawn under the discovered view", () => {
    expect(rule(launcherProjectsCss, ".launcher-project-form[hidden]")).toMatch(/display:\s*none/);
  });
});
