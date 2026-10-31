// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  DetailHeader,
  ExternalLinkOwnedContext,
  IconButton,
  SidebarRow,
  SidebarSection,
  StatusChip,
  StatusTriad,
  ViewHeader,
} from "./index.js";
import css from "../../styles/sidebar-kit.css?raw";
import { useDashboardStore } from "../../store/index.js";

beforeEach(() => localStorage.clear());

describe("IconButton", () => {
  it("names itself with aria-label only (no native title)", () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Fetch" onClick={onClick}>
        <i />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Fetch" });
    expect(btn).not.toHaveAttribute("title");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  describe("tooltip", () => {
    it("shows on focus immediately and hides on blur", () => {
      render(
        <IconButton label="Fetch">
          <i />
        </IconButton>,
      );
      const btn = screen.getByRole("button", { name: "Fetch" });
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.focus(btn);
      expect(screen.getByRole("tooltip")).toHaveTextContent("Fetch");
      expect(btn.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
      fireEvent.blur(btn);
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("carries the theme classes, since it portals outside .cmux-root", () => {
      const { unmount } = render(
        <IconButton label="Fetch">
          <i />
        </IconButton>,
      );
      fireEvent.focus(screen.getByRole("button", { name: "Fetch" }));
      expect(screen.getByRole("tooltip")).toHaveClass("cmux-root");
      expect(screen.getByRole("tooltip")).not.toHaveClass("light");
      unmount();

      useDashboardStore.setState({ theme: "light" });
      try {
        render(
          <IconButton label="Fetch">
            <i />
          </IconButton>,
        );
        fireEvent.focus(screen.getByRole("button", { name: "Fetch" }));
        expect(screen.getByRole("tooltip")).toHaveClass("cmux-root", "light");
      } finally {
        useDashboardStore.setState({ theme: "dark" });
      }
    });

    it("hides on Escape", () => {
      render(
        <IconButton label="Fetch">
          <i />
        </IconButton>,
      );
      fireEvent.focus(screen.getByRole("button", { name: "Fetch" }));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("shows after the hover delay and hides on pointer leave", () => {
      vi.useFakeTimers();
      try {
        render(
          <IconButton label="Open" href="https://github.com/o/r">
            <i />
          </IconButton>,
        );
        const a = screen.getByRole("link", { name: "Open" });
        expect(a).not.toHaveAttribute("title");
        fireEvent.pointerEnter(a);
        act(() => {
          vi.advanceTimersByTime(150);
        });
        expect(screen.queryByRole("tooltip")).toBeNull();
        act(() => {
          vi.advanceTimersByTime(60);
        });
        expect(screen.getByRole("tooltip")).toHaveTextContent("Open");
        fireEvent.pointerLeave(a);
        expect(screen.queryByRole("tooltip")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending hover on pointer leave and ignores touch", () => {
      vi.useFakeTimers();
      try {
        render(
          <IconButton label="Fetch">
            <i />
          </IconButton>,
        );
        const btn = screen.getByRole("button", { name: "Fetch" });
        fireEvent.pointerEnter(btn);
        fireEvent.pointerLeave(btn);
        fireEvent.pointerEnter(btn, { pointerType: "touch" });
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(screen.queryByRole("tooltip")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
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

  it("leaves the GitHub link to its owner, and can pin itself", () => {
    const { container } = render(
      <ExternalLinkOwnedContext.Provider value={true}>
        <ViewHeader title="Owned" sticky externalUrl="https://github.com/o/r" />
      </ExternalLinkOwnedContext.Provider>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector(".sb-vh--sticky")).not.toBeNull();
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

  it("activates once from the title button or the row body; actions are siblings, not descendants", () => {
    const onClick = vi.fn();
    const onAct = vi.fn();
    const { container } = render(
      <SidebarRow
        title="row"
        meta="m"
        selected
        onClick={onClick}
        actions={<button onClick={onAct}>Delete</button>}
      />,
    );
    const title = screen.getByRole("button", { name: "row" });
    expect(title).toHaveAttribute("aria-current", "true");
    // No role="button" wrapper around the nested action.
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(title.contains(screen.getByRole("button", { name: "Delete" }))).toBe(false);
    fireEvent.click(title);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("m"));
    expect(onClick).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe("SidebarRow hover actions do not shift layout", () => {
  it("keeps the body markup identical across hover and focus", () => {
    const { container } = render(
      <SidebarRow title="row" meta="m" actions={<button>Act</button>} trailing={<span>3</span>} />,
    );
    const row = container.querySelector(".sb-row")!;
    const body = container.querySelector(".sb-row-body")!;
    const before = body.outerHTML;
    fireEvent.mouseEnter(row);
    fireEvent.focus(screen.getByRole("button", { name: "Act" }));
    expect(body.outerHTML).toBe(before);
    // Actions stay rendered (Tab-reachable) and sit before the trailing content.
    const actions = container.querySelector(".sb-row-trail > .sb-row-actions")!;
    expect(actions.nextElementSibling?.textContent).toBe("3");
  });

  it("overlays .sb-row-actions out of flow instead of toggling display", () => {
    // Plain string search (no regex built from the selector, so nothing to escape).
    const rule = (sel: string) => {
      const start = css.indexOf(`\n${sel} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const open = css.indexOf("{", start);
      return css.slice(open + 1, css.indexOf("}", open));
    };
    const base = rule(".sb-row-actions");
    expect(base).toContain("position: absolute");
    expect(base).toContain("right: 100%");
    expect(base).not.toContain("display: none");
    expect(css).not.toMatch(/\.sb-row:hover \.sb-row-actions[^{]*\{[^}]*display:/);
  });
});

describe("SidebarRow click isolation", () => {
  it("does not activate the row from clicks inside extra or trailing", () => {
    const onClick = vi.fn();
    render(
      <SidebarRow
        title="row"
        onClick={onClick}
        extra={<button>drill</button>}
        trailing={<button>chip</button>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "drill" }));
    fireEvent.click(screen.getByRole("button", { name: "chip" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("SidebarSection persistence hardening", () => {
  it("ignores a non-object stored value", () => {
    localStorage.setItem("crs.sidebarKitSections", "null");
    render(
      <SidebarSection title="Z" persistKey="z" defaultOpen={false}>
        <p>inside</p>
      </SidebarSection>,
    );
    expect(screen.queryByText("inside")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Z/ }));
    expect(screen.getByText("inside")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("crs.sidebarKitSections")!)).toEqual({ z: true });
  });
});
