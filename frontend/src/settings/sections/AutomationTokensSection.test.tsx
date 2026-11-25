// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomationTokensSection } from "./AutomationTokensSection.js";
import { jsonResponse } from "../../test/jsonResponse.js";

const SECRET = `mat_${"ab".repeat(32)}`;

describe("AutomationTokensSection (issue #3440)", () => {
  let tokensDb: Array<{
    id: string;
    label: string;
    scopes: ("enroll" | "repair")[];
    expires_at: string;
    allowed_cidrs: string | null;
    require_approval: boolean;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
    state: "active" | "expired" | "revoked";
  }>;

  beforeEach(() => {
    tokensDb = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/automation-tokens" && method === "GET") {
          return Promise.resolve(jsonResponse(200, tokensDb));
        }
        if (url === "/api/automation-tokens" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            label: string;
            scopes: ("enroll" | "repair")[];
            expiresInDays?: number;
            allowedCidrs?: string | null;
            requireApproval?: boolean;
          };
          const summary = {
            id: "tok-1",
            label: body.label,
            scopes: body.scopes,
            expires_at: new Date(
              Date.now() + (body.expiresInDays ?? 90) * 86_400_000,
            ).toISOString(),
            allowed_cidrs: body.allowedCidrs ?? null,
            require_approval: Boolean(body.requireApproval),
            created_at: new Date().toISOString(),
            last_used_at: null,
            revoked_at: null,
            state: "active" as const,
          };
          tokensDb = [summary];
          return Promise.resolve(jsonResponse(201, { ...summary, token: SECRET }));
        }
        if (url === "/api/automation-tokens/tok-1" && method === "DELETE") {
          tokensDb = tokensDb.map((t) =>
            t.id === "tok-1"
              ? { ...t, state: "revoked" as const, revoked_at: new Date().toISOString() }
              : t,
          );
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows the token once on creation, never in the list, and lets the operator revoke it", async () => {
    const user = userEvent.setup();
    render(<AutomationTokensSection />);

    await user.click(screen.getByText("Create automation token"));
    await user.type(screen.getByLabelText("Label"), "ansible-prod");
    await user.click(screen.getByLabelText(/repair/));
    await user.selectOptions(screen.getByLabelText("Lifetime"), "30");
    await user.type(screen.getByLabelText(/Allowed CIDRs/), "10.0.0.0/8");
    await user.click(screen.getByLabelText(/Require operator approval/));
    await user.click(screen.getByText("Create token"));

    // Token shown once in the creation banner.
    const secretEl = await screen.findByTestId("automation-token-secret");
    expect(secretEl).toHaveTextContent(SECRET);

    // List row shows metadata, never the token secret.
    const row = await screen.findByTestId("automation-token-row-tok-1");
    expect(row).toHaveTextContent("ansible-prod");
    expect(row).toHaveTextContent("enroll, repair");
    expect(row).toHaveTextContent("never used");
    expect(row).toHaveTextContent("CIDRs: 10.0.0.0/8");
    expect(row).toHaveTextContent("approval required");
    expect(row).not.toHaveTextContent(SECRET);

    // Dismissing hides the one-time banner; the secret is gone from the DOM.
    await user.click(screen.getByText("Dismiss"));
    expect(screen.queryByTestId("automation-token-secret")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);

    // Revoking marks the token revoked.
    await user.click(screen.getByText("Revoke"));
    await waitFor(() =>
      expect(screen.getByTestId("automation-token-state-tok-1")).toHaveTextContent("revoked"),
    );
  });
});
