// Drives the exit of an overlay (lib/presence.ts) in jsdom, which has no Web
// Animations. Installs an `Element.prototype.getAnimations` that reports one
// running exit animation for every element whose subtree carries
// `data-presence="leaving"` (what styles/motion.css would start), and lets the
// test finish those exits when it chooses. Nothing here knows a duration: the
// test asserts the leaving state, then calls `finishExits()` and asserts the
// overlay is gone.
//
//   const exits = installExitAnimations();
//   ...close the overlay...
//   expect(menu).toHaveAttribute("data-presence", "leaving");
//   await exits.finishExits();
//   expect(menu).not.toBeInTheDocument();
//   exits.restore(); // or rely on the afterEach in the test file
import { act } from "@testing-library/react";

interface Pending {
  resolve: () => void;
}

export interface ExitAnimations {
  /** Finishes every exit that has started, and lets React unmount what left. */
  finishExits(): Promise<void>;
  /** How many exits are playing right now. */
  pending(): number;
  /** Puts jsdom's own (absent) getAnimations back. */
  restore(): void;
}

export function installExitAnimations(): ExitAnimations {
  const proto = Element.prototype as { getAnimations?: unknown };
  const had = Object.prototype.hasOwnProperty.call(proto, "getAnimations");
  const original = proto.getAnimations;
  // One animation per leaving element, so asking twice does not start two.
  const playing = new Map<Element, { animation: Animation; pending: Pending }>();

  const exitFor = (el: Element): Animation => {
    const existing = playing.get(el);
    if (existing) return existing.animation;
    let resolve!: () => void;
    const finished = new Promise<Animation>((r) => {
      resolve = () => r(animation);
    });
    const animation = {
      finished,
      effect: { getTiming: () => ({ iterations: 1 }) },
    } as unknown as Animation;
    playing.set(el, { animation, pending: { resolve } });
    return animation;
  };

  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    writable: true,
    value(this: Element, options?: { subtree?: boolean }) {
      const leaving: Element[] = [];
      if (this.getAttribute("data-presence") === "leaving") leaving.push(this);
      if (options?.subtree) leaving.push(...this.querySelectorAll('[data-presence="leaving"]'));
      return leaving.map(exitFor);
    },
  });

  return {
    async finishExits() {
      const all = [...playing.values()];
      playing.clear();
      await act(async () => {
        for (const { pending } of all) pending.resolve();
        // lib/presence.ts settles through a few promise hops; drain them all.
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
    },
    pending: () => playing.size,
    restore() {
      if (had) Object.defineProperty(Element.prototype, "getAnimations", { value: original });
      else delete proto.getAnimations;
    },
  };
}
