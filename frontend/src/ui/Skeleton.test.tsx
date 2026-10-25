// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Skeleton, SkeletonRegion } from "./Skeleton.js";

// Issue #1885 — the bone is hidden from assistive technology, and the
// shimmer (motion that only says "still working") is absent when the user
// has asked the OS not to animate. jsdom does not evaluate CSS media
// queries, so the reduced-motion decision under test is the class the
// component withholds, which is what stops the sweep rather than merely
// shortening it.
function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe("ui/Skeleton", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is hidden from assistive technology and shimmers by default", () => {
    const { container } = render(<Skeleton />);
    const bone = container.querySelector(".ui-skeleton");
    expect(bone).toBeInTheDocument();
    expect(bone).toHaveAttribute("aria-hidden", "true");
    expect(bone).toHaveClass("ui-skeleton-shimmer");
    // A bone is not a word. Nothing here for a screen reader to read.
    expect(bone).toHaveTextContent("");
  });

  it("omits the shimmer when prefers-reduced-motion is set", () => {
    stubReducedMotion(true);
    const { container } = render(<Skeleton />);
    const bone = container.querySelector(".ui-skeleton");
    expect(bone).toBeInTheDocument();
    expect(bone).toHaveAttribute("aria-hidden", "true");
    expect(bone).not.toHaveClass("ui-skeleton-shimmer");
  });

  it("keeps the shimmer when the user has not requested reduced motion", () => {
    stubReducedMotion(false);
    const { container } = render(<Skeleton />);
    expect(container.querySelector(".ui-skeleton")).toHaveClass("ui-skeleton-shimmer");
  });

  it("applies caller dimensions as pixel lengths", () => {
    const { container } = render(<Skeleton width={120} height={32} radius={8} />);
    const bone = container.querySelector(".ui-skeleton") as HTMLElement;
    expect(bone.style.width).toBe("120px");
    expect(bone.style.height).toBe("32px");
    expect(bone.style.borderRadius).toBe("8px");
  });

  it("announces loading outside any busy ancestor and does not mark hidden bones busy", () => {
    const { container } = render(
      <SkeletonRegion label="Loading GitHub">
        <Skeleton />
      </SkeletonRegion>,
    );
    const region = container.firstElementChild as HTMLElement;
    const bones = region.querySelector(".ui-skeleton-bones");
    // The bones are hidden, so aria-busy on them is never exposed. The
    // status must also sit outside any busy ancestor: assistive technology
    // defers announcements inside an aria-busy subtree.
    expect(bones).not.toHaveAttribute("aria-busy");
    expect(bones).toHaveAttribute("aria-hidden", "true");
    expect(region).not.toHaveAttribute("aria-busy");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading GitHub");
    expect(status).toHaveClass("visually-hidden");
    expect(status.closest("[aria-busy='true']")).toBeNull();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    const bone = container.querySelector(".ui-skeleton");
    expect(bone).toHaveAttribute("aria-hidden", "true");
    // closest() on the bone itself matches the bone's own aria-hidden, so
    // deleting the group's aria-hidden would still pass. Start at the parent.
    expect(bone?.parentElement?.closest("[aria-hidden='true']")).toBe(bones);
  });
});
