// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlayTriangleIcon } from "./icons.js";

describe("PlayTriangleIcon", () => {
  it("follows the surrounding text colour, not a hard-coded white", () => {
    const { container } = render(<PlayTriangleIcon />);
    expect(container.querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });
});
