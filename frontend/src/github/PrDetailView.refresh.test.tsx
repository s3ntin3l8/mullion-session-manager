// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrDetailView } from "./PrDetailView.js";
import { PR, stub } from "./prDetailTestKit.js";

describe("PrDetailView Refresh", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows Refresh as busy until the re-fetch settles and ignores a second click", async () => {
    const fn = stub(PR);
    const real = fn.getMockImplementation()!;
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    await screen.findByText(/Add thing/);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fn.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/prs/12")) await gate;
      return real(url, init);
    });
    const prFetches = () => fn.mock.calls.filter((c) => String(c[0]).endsWith("/prs/12")).length;
    const before = prFetches();

    const btn = screen.getByRole("button", { name: "Refresh" });
    await userEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
    await userEvent.click(btn);
    expect(prFetches()).toBe(before + 1);

    release();
    await waitFor(() => expect(btn).not.toHaveAttribute("aria-busy"));
  });
});
