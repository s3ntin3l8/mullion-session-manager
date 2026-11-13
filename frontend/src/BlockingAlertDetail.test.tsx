// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockingAlertDetail } from "./BlockingAlertDetail.js";
import type { BlockingAlertsResponse } from "./api/blocking-alerts-types.js";

const getBlockingAlerts = vi.fn();
const dismissBlockingAlert = vi.fn();
vi.mock("./api/index.js", () => ({
  api: {
    getBlockingAlerts: (id: number) => getBlockingAlerts(id),
    dismissBlockingAlert: (...a: unknown[]) => dismissBlockingAlert(...a),
  },
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
    dismissals: [],
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
  beforeEach(() => {
    getBlockingAlerts.mockReset();
    dismissBlockingAlert.mockReset();
  });

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
      dismissals: [],
    });
    render(<BlockingAlertDetail taskId={3} raw={raw} />);
    expect(await screen.findByText(/Alert #7: details unavailable \(boom\)/)).toBeInTheDocument();
  });

  describe("dismiss (#2999)", () => {
    async function openConfirm() {
      getBlockingAlerts.mockResolvedValue(payload({ ok: true }));
      render(<BlockingAlertDetail taskId={3} raw={raw} />);
      fireEvent.click(await screen.findByTestId("blocking-alert-dismiss"));
    }
    const confirm = () => screen.getByTestId("blocking-alert-dismiss-confirm");

    it("restates the rule and location; confirm needs a non-empty comment of at most 280", async () => {
      await openConfirm();
      expect(screen.getByTestId("blocking-alert-dismiss-form")).toHaveTextContent(
        "js/path-injection at src/routes/fs.ts:10",
      );
      expect(screen.getByLabelText("Dismissal reason")).toHaveValue("false positive");
      expect(confirm()).toBeDisabled();
      const box = screen.getByLabelText("Dismissal comment");
      fireEvent.change(box, { target: { value: "   " } });
      expect(confirm()).toBeDisabled();
      fireEvent.change(box, { target: { value: "x".repeat(281) } });
      expect(confirm()).toBeDisabled();
      expect(screen.getByTestId("blocking-alert-counter")).toHaveTextContent("281/280");
      fireEvent.change(box, { target: { value: "x".repeat(280) } });
      expect(confirm()).toBeEnabled();
    });

    it("hides the button, keeping the reason, when canDismiss is not ok", async () => {
      getBlockingAlerts.mockResolvedValue(payload({ ok: false, reason: "Missing scope." }));
      render(<BlockingAlertDetail taskId={3} raw={raw} />);
      expect(await screen.findByTestId("blocking-alert-note")).toHaveTextContent("Missing scope.");
      expect(screen.queryByTestId("blocking-alert-dismiss")).toBeNull();
    });

    it("posts the trimmed comment and shows the audit line afterwards", async () => {
      dismissBlockingAlert.mockResolvedValue({
        dismissed: true,
        threadResolved: true,
        dismissal: {
          alertNumber: 7,
          ruleId: "js/path-injection",
          path: "src/routes/fs.ts",
          reason: "won't fix",
          comment: "ok",
          dismissedBy: "me",
          threadResolved: true,
          createdAt: "2026-01-02T03:04:05Z",
        },
      });
      await openConfirm();
      fireEvent.change(screen.getByLabelText("Dismissal reason"), {
        target: { value: "won't fix" },
      });
      fireEvent.change(screen.getByLabelText("Dismissal comment"), { target: { value: " ok " } });
      fireEvent.click(confirm());
      expect(await screen.findByTestId("blocking-alert-audit")).toHaveTextContent(
        /^Dismissed #7 as won't fix by me, /,
      );
      expect(dismissBlockingAlert).toHaveBeenCalledWith(3, 7, {
        reason: "won't fix",
        comment: "ok",
      });
      expect(screen.queryByTestId("blocking-alert-dismiss")).toBeNull();
    });

    it("keeps the confirm open and shows the error when the dismissal fails", async () => {
      dismissBlockingAlert.mockRejectedValue(new Error("nope"));
      await openConfirm();
      fireEvent.change(screen.getByLabelText("Dismissal comment"), { target: { value: "c" } });
      fireEvent.click(confirm());
      expect(await screen.findByText("Failed to dismiss the alert")).toBeInTheDocument();
      await waitFor(() => expect(confirm()).toBeEnabled());
      expect(screen.queryByTestId("blocking-alert-audit")).toBeNull();
    });

    it("shows audit lines the GET returns on a reload", async () => {
      const p = payload({ ok: true });
      p.dismissals = [
        {
          alertNumber: 5,
          ruleId: "r",
          path: null,
          reason: "false positive",
          comment: "c",
          dismissedBy: "me",
          threadResolved: false,
          createdAt: "2026-01-02T03:04:05Z",
        },
      ];
      getBlockingAlerts.mockResolvedValue(p);
      render(<BlockingAlertDetail taskId={3} raw={raw} />);
      expect(await screen.findByTestId("blocking-alert-audit")).toHaveTextContent(
        /Dismissed #5 as false positive by me, .*thread left open/,
      );
    });
  });
});
