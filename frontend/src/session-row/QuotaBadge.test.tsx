// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuotaBadge } from "./QuotaBadge.js";
import type { RunwayAgentQuota, RunwayQuota } from "../api/index.js";

// The badge is a pure function of the snapshot and the session's command:
// what matters is that it stays SILENT whenever Runway has nothing to say —
// and loud only about the agent it actually has a reading for.

function agent(over: Partial<RunwayAgentQuota> = {}): RunwayAgentQuota {
  return {
    agent: "claude",
    providerId: "anthropic",
    pctUsed: 87,
    resetAt: null,
    exhausted: false,
    quarantined: false,
    ...over,
  };
}

function quota(over: Partial<RunwayQuota> = {}): RunwayQuota {
  return {
    configured: true,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    agents: [agent()],
    unmappedProviders: [],
    ...over,
  };
}

describe("QuotaBadge", () => {
  it("renders nothing when the feature is not configured", () => {
    render(<QuotaBadge quota={quota({ configured: false })} command="claude" />);
    expect(screen.queryByTestId("quota-badge")).not.toBeInTheDocument();
  });

  it("renders nothing when the fetch failed (no snapshot at all)", () => {
    // fetchedAt null means "no quota information" — never a reassuring "OK".
    render(<QuotaBadge quota={quota({ fetchedAt: null, agents: [] })} command="claude" />);
    expect(screen.queryByTestId("quota-badge")).not.toBeInTheDocument();
  });

  it("renders nothing while the snapshot is still in flight", () => {
    render(<QuotaBadge quota={null} command="claude" />);
    expect(screen.queryByTestId("quota-badge")).not.toBeInTheDocument();
  });

  it("renders nothing for an agent Runway says nothing about", () => {
    render(<QuotaBadge quota={quota({ agents: [] })} command="claude" />);
    expect(screen.queryByTestId("quota-badge")).not.toBeInTheDocument();
  });

  it("shows the used percentage for the session's agent", () => {
    render(<QuotaBadge quota={quota()} command="claude" />);
    const badge = screen.getByTestId("quota-badge");
    expect(badge).toHaveTextContent("quota 87%");
    expect(badge.querySelector(".github-panel-ci-dot")).toHaveClass("good");
  });

  it("matches the agent by its CLI name too", () => {
    render(
      <QuotaBadge quota={quota({ agents: [agent({ agent: "claude-code" })] })} command="claude" />,
    );
    expect(screen.getByTestId("quota-badge")).toHaveTextContent("quota 87%");
  });

  it("says 'quota out' when the provider is exhausted", () => {
    render(<QuotaBadge quota={quota({ agents: [agent({ exhausted: true })] })} command="claude" />);
    const badge = screen.getByTestId("quota-badge");
    expect(badge).toHaveTextContent("quota out");
    expect(badge.querySelector(".github-panel-ci-dot")).toHaveClass("bad");
  });

  it("says 'quota out' when the agent is quarantined", () => {
    render(
      <QuotaBadge quota={quota({ agents: [agent({ quarantined: true })] })} command="claude" />,
    );
    const badge = screen.getByTestId("quota-badge");
    expect(badge).toHaveTextContent("quota out");
    expect(badge.querySelector(".github-panel-ci-dot")).toHaveClass("bad");
  });

  it("takes the worst reading when Runway reports several cards for one agent", () => {
    render(
      <QuotaBadge
        quota={quota({
          agents: [agent({ pctUsed: 20 }), agent({ pctUsed: 95, providerId: "anthropic-pro" })],
        })}
        command="claude"
      />,
    );
    const badge = screen.getByTestId("quota-badge");
    expect(badge).toHaveTextContent("quota 95%");
    expect(badge.querySelector(".github-panel-ci-dot")).toHaveClass("pending");
  });

  it("ignores a session that runs no known agent", () => {
    render(<QuotaBadge quota={quota()} command="/bin/bash -l" />);
    expect(screen.queryByTestId("quota-badge")).not.toBeInTheDocument();
  });

  it("says how old the reading is, so a stale one cannot look live", () => {
    // The snapshot is taken when the server last polled Runway; with
    // polling off (or Runway unreachable) it can be hours old while still
    // being the last thing known. The chip must not present it as current.
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    render(<QuotaBadge quota={quota({ fetchedAt: old })} command="claude" />);
    const badge = screen.getByTestId("quota-badge");
    expect(badge.getAttribute("title")).toContain("3 h ago");
  });

  it("says the reading is current when it was just taken", () => {
    const fresh = new Date(Date.now() - 5_000).toISOString();
    render(<QuotaBadge quota={quota({ fetchedAt: fresh })} command="claude" />);
    const badge = screen.getByTestId("quota-badge");
    expect(badge.getAttribute("title")).toContain("just now");
  });

  describe("opencode provider targets (#2054)", () => {
    const xai = agent({ agent: "opencode/xai", providerId: "xai", pctUsed: 100, exhausted: true });
    const go = agent({ agent: "opencode/opencode-go", providerId: "opencode", pctUsed: 20 });

    it("reads the quota of the provider the session's model runs on", () => {
      render(
        <QuotaBadge quota={quota({ agents: [go, xai] })} command="opencode" model="xai/grok-4" />,
      );
      expect(screen.getByTestId("quota-badge").textContent).toBe("quota out");
    });

    it("stays silent for a model whose provider Runway says nothing about", () => {
      render(
        <QuotaBadge quota={quota({ agents: [xai] })} command="opencode" model="openrouter/x" />,
      );
      expect(screen.queryByTestId("quota-badge")).not.toBeInTheDocument();
    });

    it("shows the bare agent being out even when the session's own provider is fine", () => {
      // The gate holds on ANY target, so the chip must not reassure.
      const bareOut = agent({
        agent: "opencode",
        providerId: "opencode",
        pctUsed: 100,
        exhausted: true,
      });
      const xaiOk = agent({ agent: "opencode/xai", providerId: "xai", pctUsed: 10 });
      render(
        <QuotaBadge
          quota={quota({ agents: [xaiOk, bareOut] })}
          command="opencode"
          model="xai/grok-4"
        />,
      );
      expect(screen.getByTestId("quota-badge").textContent).toBe("quota out");
    });

    it("with no model, shows any opencode provider that is out — as the gate treats it", () => {
      render(<QuotaBadge quota={quota({ agents: [go, xai] })} command="opencode" model={null} />);
      expect(screen.getByTestId("quota-badge").textContent).toBe("quota out");
    });

    it("with no model and no provider out, shows the bare agent's reading", () => {
      const bare = agent({ agent: "opencode", providerId: "opencode", pctUsed: 42 });
      render(<QuotaBadge quota={quota({ agents: [bare, go] })} command="opencode" model={null} />);
      expect(screen.getByTestId("quota-badge").textContent).toBe("quota 42%");
    });
  });
});
