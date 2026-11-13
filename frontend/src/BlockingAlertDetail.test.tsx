// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BlockingAlertDetail } from "./BlockingAlertDetail.js";
import type { BlockingAlertsResponse } from "./api/blocking-alerts-types.js";

const getBlockingAlerts = vi.fn();
vi.mock("./api/index.js", () => ({
  api: { getBlockingAlerts: (id: number) => getBlockingAlerts(id) },
}));

const raw = JSON.stringify({
  total: 1,
  threads: [
    {
      author: "github-advanced-security[bot]",
      location: "src/routes/fs.ts:10",
      excerpt: "Path injection",
      url: null,
      alert: { number: 7, url: "https://github.com/o/r/security/code-scanning/7" },
    },
  ],
});

const payload = (canDismiss: BlockingAlertsResponse["alerts"][number]["canDismiss"]) =>
  ({
    alerts: [
      {
        number: 7,
        alert: {
          rule: {
            id: "js/path-injection",
            description: "Uncontrolled data used in path expression",
            severity: "error",
            securitySeverity: "high",
          },
          location: { path: "src/routes/fs.ts", startLine: 10, endLine: 10 },
          message: "This path depends on a user-provided value.",
          commitSha: "abc",
          state: "open",
          htmlUrl: "https://github.com/o/r/security/code-scanning/7",
        },
        snippet: [
          { number: 9, text: "const a = 1;", flagged: false },
          { number: 10, text: "readFile(p);", flagged: true },
        ],
        priorDismissals: {
          dismissals: [
            {
              number: 517,
              path: "src/routes/fs.ts",
              reason: "false positive",
              comment: "validated upstream",
              dismissedBy: "s3ntin3l8",
              url: "https://github.com/o/r/security/code-scanning/517",
            },
          ],
          otherPathCount: 2,
        },
        canDismiss,
      },
    ],
  }) as BlockingAlertsResponse;

describe("BlockingAlertDetail", () => {
  beforeEach(() => getBlockingAlerts.mockReset());

  it("renders rule, snippet with flagged lines and prior dismissals", async () => {
    getBlockingAlerts.mockResolvedValue(payload({ ok: true }));
    render(<BlockingAlertDetail taskId={3} raw={raw} />);
    expect(await screen.findByText("js/path-injection")).toBeInTheDocument();
    expect(getBlockingAlerts).toHaveBeenCalledWith(3);
    expect(screen.getByText(/high/)).toBeInTheDocument();
    expect(screen.getByText("Uncontrolled data used in path expression")).toBeInTheDocument();
    expect(screen.getByText("src/routes/fs.ts:10")).toBeInTheDocument();
    expect(screen.getByText("This path depends on a user-provided value.")).toBeInTheDocument();
    const flagged = screen.getByText(/readFile\(p\);/);
    expect(flagged).toHaveAttribute("data-flagged", "true");
    expect(screen.getByText(/const a = 1;/)).not.toHaveAttribute("data-flagged");
    const prior = screen.getByRole("link", {
      name: "#517 src/routes/fs.ts: false positive by s3ntin3l8: validated upstream",
    });
    expect(prior).toHaveAttribute("href", "https://github.com/o/r/security/code-scanning/517");
    expect(screen.getByText("and 2 more dismissed with this rule")).toBeInTheDocument();
    expect(screen.queryByTestId("blocking-alert-note")).toBeNull();
  });

  it("shows the permission note without removing the rest", async () => {
    getBlockingAlerts.mockResolvedValue(
      payload({ ok: false, reason: "Connect a GitHub account." }),
    );
    render(<BlockingAlertDetail taskId={3} raw={raw} />);
    expect(await screen.findByTestId("blocking-alert-note")).toHaveTextContent(
      "Connect a GitHub account.",
    );
    expect(screen.getByText("js/path-injection")).toBeInTheDocument();
    expect(screen.getByTestId("blocking-alert-snippet")).toBeInTheDocument();
  });

  it("makes no request when no thread is an alert", () => {
    const plain = JSON.stringify({ total: 1, threads: [{ author: "x", alert: null }] });
    render(<BlockingAlertDetail taskId={3} raw={plain} />);
    expect(getBlockingAlerts).not.toHaveBeenCalled();
  });

  it("renders an errored entry's message", async () => {
    getBlockingAlerts.mockResolvedValue({
      alerts: [{ number: 7, error: "boom", canDismiss: { ok: true } }],
    });
    render(<BlockingAlertDetail taskId={3} raw={raw} />);
    expect(await screen.findByText(/Alert #7: details unavailable \(boom\)/)).toBeInTheDocument();
  });
});
