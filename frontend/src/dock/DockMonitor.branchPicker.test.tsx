// @vitest-environment jsdom
// Issue #2495 — the dock row's branch picker (`main ⌄` on the "Dev server"
// row) opened a list that ran off the LEFT edge of the screen, clipped long
// branch names on that side, and offered no way to find one branch among
// dozens. The behaviour itself lives in ui/CustomSelect.tsx (`searchable`,
// middle-truncation, the viewport width cap) and is covered there; this file
// covers the DOCK'S OWN wiring of it — that the picker is searchable, that
// it names the empty state, and that the full branch name survives in the
// option's tooltip and accessible name.
//
// A sibling file rather than more cases in DockMonitor.test.tsx: that file
// is already past this repo's 1,200-line ceiling and the ratchet
// (scripts/check-max-file-lines.mjs) forbids growing it. DockMonitor is
// presentational — every value it renders is a prop — so rendering it
// directly is both smaller and closer to what is under test than mounting
// the whole <Dock> through a fake backend.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DockMonitor } from "./DockMonitor.js";
import type { DockControl } from "../api/index.js";
import type { CustomSelectOption } from "../ui/CustomSelect.js";

const CONTROL: DockControl = { id: "dev", title: "Dev server", command: "npm run dev" };

// Long enough that the middle-ellipsis has to cut it at a narrow width, and
// shaped like the branch names the issue's screenshot showed: a shared
// `fix(...)` prefix with the distinguishing words at the tail.
const LONG_BRANCH = "fix(dock): the dock branch picker runs off-screen and cannot be searched";
const LONG_BRANCH_LABEL = `${LONG_BRANCH} (preview)`;

const OPTIONS: CustomSelectOption[] = [
  { value: "/home/x/mullion", label: "main" },
  { value: "branch:feature-y", label: "feature-y (preview)" },
  { value: `branch:${LONG_BRANCH}`, label: LONG_BRANCH_LABEL },
];

function renderMonitor(onWorktreeChange = vi.fn()) {
  return render(
    <DockMonitor
      control={CONTROL}
      running={undefined}
      selected={false}
      showSelector
      selectedValue="/home/x/mullion"
      worktreeOptions={OPTIONS}
      onWorktreeChange={onWorktreeChange}
      updateAvailable={false}
      dockerStatus={null}
      checkStatus={undefined}
      armed={false}
      confirmBeforeKill={false}
      onSelect={vi.fn()}
      onToggleStream={vi.fn()}
      pinned={false}
      canShowSecondPane={false}
      onTogglePin={vi.fn()}
      onCheckUpdate={vi.fn()}
      onServiceRestart={vi.fn()}
      onServiceStop={vi.fn()}
      onServiceStart={vi.fn()}
    />,
  );
}

async function openPicker() {
  const user = userEvent.setup();
  renderMonitor();
  await user.click(screen.getByRole("button", { name: "Dev server worktree" }));
  return user;
}

describe("dock branch picker (issue #2495)", () => {
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
    });
  });

  it("is searchable: a filter input narrows the branch list as the user types", async () => {
    const user = await openPicker();

    const filter = screen.getByRole("combobox");
    expect(filter).toHaveFocus();
    await user.type(filter, "FEATURE");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("data-value", "branch:feature-y");
  });

  it("names the empty state in the picker's own words when nothing matches", async () => {
    const user = await openPicker();
    await user.type(screen.getByRole("combobox"), "zzz-no-such-branch");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching branches")).toBeInTheDocument();
  });

  it("selects a filtered branch, keeping the (preview) suffix on branch-only entries", async () => {
    const user = userEvent.setup();
    const onWorktreeChange = vi.fn();
    renderMonitor(onWorktreeChange);
    await user.click(screen.getByRole("button", { name: "Dev server worktree" }));
    await user.type(screen.getByRole("combobox"), "feature");

    const option = screen.getByRole("option");
    expect(option).toHaveTextContent("feature-y (preview)");
    await user.click(option);

    expect(onWorktreeChange).toHaveBeenCalledWith("branch:feature-y");
  });

  it("middle-truncates a long branch label but keeps the full name in its title and accessible name", async () => {
    // A narrow dock: the trigger sits near the right edge, so the menu has
    // little room to grow into and the label budget is small.
    Object.defineProperty(window, "innerWidth", { value: 360, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 300,
      bottom: 340,
      left: 260,
      right: 340,
      width: 80,
      height: 40,
      x: 260,
      y: 300,
      toJSON: () => ({}),
    } as DOMRect);

    await openPicker();

    const option = screen.getByRole("option", { name: LONG_BRANCH_LABEL });
    const shown = option.textContent ?? "";
    expect(shown).toContain("…");
    expect(shown.length).toBeLessThan(LONG_BRANCH_LABEL.length);
    // The full name is still there — for the tooltip and for assistive tech.
    expect(option).toHaveAttribute("title", LONG_BRANCH_LABEL);
    expect(option).toHaveAttribute("aria-label", LONG_BRANCH_LABEL);
  });
});
