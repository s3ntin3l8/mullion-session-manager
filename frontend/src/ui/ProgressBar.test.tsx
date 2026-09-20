// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar.js";

describe("ProgressBar", () => {
  it("renders indeterminate progress bar with correct class", () => {
    const { container } = render(<ProgressBar />);
    expect(container.querySelector(".ui-progress-bar")).toBeInTheDocument();
    expect(container.querySelector(".ui-progress-bar-indeterminate")).toBeInTheDocument();
  });

  it("applies custom className when provided", () => {
    const { container } = render(<ProgressBar className="my-custom" />);
    expect(container.querySelector(".ui-progress-bar.my-custom")).toBeInTheDocument();
  });
});
