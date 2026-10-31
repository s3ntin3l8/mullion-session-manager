// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FailureDiagnostics } from "./FailureDiagnostics.js";

describe("FailureDiagnostics", () => {
  it("renders the snapshot text", () => {
    render(<FailureDiagnostics text={"Agent: agy\nTerminal tail: gave up"} />);
    expect(document.querySelector(".task-detail-failure-diagnostics pre")?.textContent).toContain(
      "Terminal tail: gave up",
    );
  });
});
