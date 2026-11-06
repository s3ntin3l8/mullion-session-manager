// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectSetupPanel } from "./ProjectSetupPanel.js";
import { __resetRateLimitBreakerForTests } from "./api/client.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { useDashboardStore } from "./store/index.js";

// How long the panel keeps a restored preview: 15 minutes for a template, 24
// hours for an agent-generated one (the server keeps them the same way).

// The server holds nothing; only the scaffold-defaults fetch the panel makes
// on mount has a body.
const quietServer = () =>
  vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input).endsWith("/api/workflow-conventions/scaffold-defaults")
        ? jsonResponse(200, { text: "Always branch and open a PR." })
        : new Response(null, { status: 204 }),
    ),
  );

describe("ProjectSetupPanel preview expiry", () => {
  beforeEach(() => {
    useDashboardStore.setState({ scaffoldDrafts: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetRateLimitBreakerForTests();
  });

  it("keeps an agent-generated preview past the template TTL", async () => {
    vi.stubGlobal("fetch", quietServer());
    useDashboardStore.getState().patchScaffoldDraft(1, {
      slug: "demo",
      preview: {
        previewId: "gen",
        diff: "",
        files: ["AGENTS.md"],
        hasAgentsOverride: false,
        generated: true,
        agent: "claude",
      },
      previewCreatedAt: Date.now() - 3 * 60 * 60 * 1000,
    });
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);
    expect(await screen.findByRole("button", { name: "Apply" })).toBeInTheDocument();
    expect(screen.queryByText(/This preview expired/)).not.toBeInTheDocument();
  });

  it("discards an agent-generated preview older than 24 hours", async () => {
    vi.stubGlobal("fetch", quietServer());
    useDashboardStore.getState().patchScaffoldDraft(1, {
      slug: "demo",
      preview: {
        previewId: "gen-old",
        diff: "",
        files: ["AGENTS.md"],
        hasAgentsOverride: false,
        generated: true,
        agent: "claude",
      },
      previewCreatedAt: Date.now() - 25 * 60 * 60 * 1000,
    });
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);
    expect(await screen.findByText(/This preview expired/)).toBeInTheDocument();
  });
});
