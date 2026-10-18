// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafeHtml } from "./SafeHtml.js";
import { sanitizeGithubHtml } from "../lib/sanitizeHtml.js";

describe("SafeHtml", () => {
  it("strips scripts and event handlers", () => {
    const html = sanitizeGithubHtml('<p onclick="x()">hi</p><script>alert(1)</script>');
    expect(html).toContain("<p>hi</p>");
    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
  });

  it("opens links out of the app safely", () => {
    const { container } = render(<SafeHtml html='<a href="https://example.com">x</a>' />);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
