// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  DetailHeader,
  IconButton,
  SidebarRow,
  SidebarSection,
  StatusChip,
  StatusTriad,
  ViewHeader,
} from "./index.js";

beforeEach(() => localStorage.clear());

describe("IconButton", () => {
  it("names itself with aria-label and tooltip", () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Fetch" onClick={onClick}>
        <i />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Fetch" });
    expect(btn).toHaveAttribute("title", "Fetch");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it("renders a safe external link and a status dot", () => {
    render(
      <IconButton label="Open" href="https://github.com/o/r" external dot="warn">
        <i />
      </IconButton>,
    );
    const a = screen.getByRole("link", { name: "Open" });
    expect(a).toHaveAttribute("href", "https://github.com/o/r");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.className).toContain("sb-ibtn--ext");
    expect(a.querySelector(".sb-ibtn-dot--warn")).not.toBeNull();
  });
});

describe("Button", () => {
  it("defaults to a non-submitting secondary button", () => {
    render(<Button>Go</Button>);
    const b = screen.getByRole("button", { name: "Go" });
    expect(b).toHaveAttribute("type", "button");
    expect(b.className).toContain("sb-btn--secondary");
  });

  it("applies variant, size and block", () => {
    render(
      <Button variant="danger" size="sm" block>
        Del
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Del" });
    expect(b.className).toContain("sb-btn--danger");
    expect(b.className).toContain("sb-btn--sm");
    expect(b.className).toContain("sb-btn--block");
  });
});

describe("StatusChip", () => {
  it("carries its tone class", () => {
    render(<StatusChip tone="merged">Merged</StatusChip>);
    expect(screen.getByText("Merged").className).toContain("sb-chip--merged");
  });

  it("renders full and short variants when short is given", () => {
    const { container } = render(
      <StatusChip tone="danger" short="✗1">
        CI failing
      </StatusChip>,
    );
    expect(container.querySelector(".sb-chip-full")?.textContent).toBe("CI failing");
    expect(container.querySelector(".sb-chip-short")?.textContent).toBe("✗1");
  });

  it("becomes a toggle button when clickable", () => {
    const onClick = vi.fn();
    render(
      <StatusChip tone="info" onClick={onClick} pressed>
        Review
      </StatusChip>,
    );
    const b = screen.getByRole("button", { name: "Review" });
    expect(b).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalled();
  });
});

describe("StatusTriad", () => {
  it("renders CI, Review and Merge and marks the open drilldown", () => {
    const onCi = vi.fn();
    render(
      <StatusTriad
        openKey="ci"
        items={[
          { key: "ci", tone: "danger", label: "CI failing", short: "✗1", onClick: onCi },
          { key: "review", tone: "warn", label: "Awaiting review", onClick: () => {} },
          { key: "merge", tone: "success", label: "Mergeable" },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "PR status" })).toBeInTheDocument();
    const ci = screen.getByRole("button", { name: /CI failing/ });
    expect(ci).toHaveAttribute("aria-expanded", "true");
    expect(ci.className).toContain("sb-chip--open");
    expect(screen.getByRole("button", { name: /Awaiting review/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(ci);
    expect(onCi).toHaveBeenCalled();
    expect(screen.getByText("Mergeable").tagName).toBe("SPAN");
  });
});

describe("ViewHeader / DetailHeader", () => {
  it("puts the open-on-GitHub icon last, after the contextual actions", () => {
    render(
      <ViewHeader
        title="main"
        subtitle="↑1 ↓0"
        externalUrl="https://github.com/o/r"
        actions={
          <IconButton label="Fetch">
            <i />
          </IconButton>
        }
      />,
    );
    expect(screen.getByText("↑1 ↓0")).toBeInTheDocument();
    const links = screen.getAllByRole("button").concat(screen.getAllByRole("link"));
    expect(links.map((e) => e.getAttribute("aria-label"))).toEqual(["Fetch", "Open on GitHub"]);
    const actions = document.querySelector(".sb-vh-actions")!;
    expect(actions.lastElementChild?.getAttribute("aria-label")).toBe("Open on GitHub");
  });

  it("omits the external slot without a URL", () => {
    render(<ViewHeader title="Plain" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("DetailHeader adds a back button", () => {
    const onBack = vi.fn();
    render(<DetailHeader title="PR #1" onBack={onBack} externalUrl="https://x.test/pr/1" />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toBeInTheDocument();
  });
});

describe("SidebarSection", () => {
  it("toggles, shows the count and renders the action slot outside the toggle", () => {
    render(
      <SidebarSection title="Branches" count={3} actions={<button>Prune</button>}>
        <p>body</p>
      </SidebarSection>,
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Branches/ }).textContent).not.toContain("Prune");
    expect(screen.getByText("body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Branches/ }));
    expect(screen.queryByText("body")).toBeNull();
  });

  it("hides a zero count", () => {
    render(
      <SidebarSection title="Empty" count={0}>
        x
      </SidebarSection>,
    );
    expect(document.querySelector(".sb-count")).toBeNull();
  });

  it("persists open state under its key", () => {
    const { unmount } = render(
      <SidebarSection title="A" persistKey="a" defaultOpen={false}>
        <p>inside</p>
      </SidebarSection>,
    );
    expect(screen.queryByText("inside")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /A/ }));
    expect(screen.getByText("inside")).toBeInTheDocument();
    unmount();
    render(
      <SidebarSection title="A" persistKey="a" defaultOpen={false}>
        <p>inside</p>
      </SidebarSection>,
    );
    expect(screen.getByText("inside")).toBeInTheDocument();
  });

  it("is controllable", () => {
    const onToggle = vi.fn();
    render(
      <SidebarSection title="C" open={false} onToggle={onToggle}>
        <p>hidden</p>
      </SidebarSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: /C/ }));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.queryByText("hidden")).toBeNull();
  });
});

describe("SidebarRow", () => {
  it("lays out lead, title, meta, extra and trailing", () => {
    const { container } = render(
      <SidebarRow
        lead={<span data-testid="lead" />}
        title="feat/x"
        meta="2h ago"
        extra={<span>pills</span>}
        trailing={<StatusChip tone="success">Open</StatusChip>}
      />,
    );
    expect(screen.getByTestId("lead").parentElement?.className).toContain("sb-row-lead");
    expect(screen.getByText("feat/x").className).toContain("sb-row-title");
    expect(screen.getByText("2h ago").className).toContain("sb-row-meta");
    expect(screen.getByText("pills")).toBeInTheDocument();
    expect(container.querySelector(".sb-row")?.className).not.toContain("sb-row--nolead");
    // Not interactive without onClick.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("flags a row without a lead glyph", () => {
    const { container } = render(<SidebarRow title="t" />);
    expect(container.querySelector(".sb-row")?.className).toContain("sb-row--nolead");
  });

  it("activates on click and on Enter/Space, but not from a nested action", () => {
    const onClick = vi.fn();
    const onAct = vi.fn();
    render(
      <SidebarRow
        title="row"
        selected
        onClick={onClick}
        actions={<button onClick={onAct}>Delete</button>}
      />,
    );
    const row = screen.getByRole("button", { name: /row/ });
    expect(row).toHaveAttribute("aria-current", "true");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(row, { key: "a" });
    expect(onClick).toHaveBeenCalledTimes(3);
    const del = screen.getByRole("button", { name: "Delete" });
    fireEvent.keyDown(del, { key: "Enter" });
    fireEvent.click(del);
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});
