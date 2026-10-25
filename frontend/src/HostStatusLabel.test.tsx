// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HostStatusLabel } from "./HostStatusLabel.js";
import { makeHost } from "./test/fixtures.js";
import type { Host } from "./api/index.js";

describe("HostStatusLabel (issue #1892)", () => {
  it("says online, in words, for a host the heartbeat reports online", () => {
    render(<HostStatusLabel host={makeHost({ health: "online" })} />);
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.queryByText("parked")).toBeNull();
  });

  it("says missed a ping for a degraded host — not unreachable", () => {
    render(<HostStatusLabel host={makeHost({ health: "degraded" })} />);
    expect(screen.getByText("missed a ping")).toBeInTheDocument();
    expect(screen.queryByText("unreachable")).toBeNull();
  });

  it("says unreachable for a host that did not answer", () => {
    render(<HostStatusLabel host={makeHost({ health: "offline" })} />);
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    expect(screen.queryByText("parked")).toBeNull();
  });

  it("says nothing for a pending host the poller has not swept", () => {
    const { container } = render(<HostStatusLabel host={makeHost({ health: "pending" })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows parked next to the derived status — drained is not a derived value", () => {
    // Settings → Hosts already calls host.drained "parked". deriveHostStatus
    // does not know that word; an unreachable parked host is both.
    render(<HostStatusLabel host={makeHost({ health: "offline", drained: true })} />);
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    expect(screen.getByText("parked")).toBeInTheDocument();
  });

  it("shows parked on its own when the heartbeat has nothing to say", () => {
    render(<HostStatusLabel host={makeHost({ health: "pending", drained: true })} />);
    expect(screen.getByText("parked")).toBeInTheDocument();
    expect(screen.queryByText("unreachable")).toBeNull();
    expect(screen.queryByText("online")).toBeNull();
  });

  it("does not call an unknown or missing health unreachable", () => {
    // KNOWN_HEALTH — a host that has not carried one of the four real
    // values must not fall through deriveHostStatus's final branch. The
    // real Host type always has one; this is the guard for a test double
    // or a row still arriving.
    const unknown = makeHost({ health: "unknown" as Host["health"] });
    const unknownView = render(<HostStatusLabel host={unknown} />);
    expect(unknownView.container).toBeEmptyDOMElement();
    expect(screen.queryByText("unreachable")).toBeNull();

    const missing = makeHost();
    delete (missing as Partial<Host>).health;
    const missingView = render(<HostStatusLabel host={missing} />);
    expect(missingView.container).toBeEmptyDOMElement();
    expect(screen.queryByText("unreachable")).toBeNull();
  });
});
