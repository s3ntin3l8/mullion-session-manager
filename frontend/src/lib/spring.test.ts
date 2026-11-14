import { describe, expect, it, vi } from "vitest";
import {
  MAX_POINTER_SAMPLES,
  Spring,
  addPointerSample,
  projectRest,
  releaseVelocity,
  rubberBand,
  stepSpring,
} from "./spring.js";
import type { FrameScheduler } from "./spring.js";

/** A frame queue the test advances by hand, at times it chooses. */
function manualFrames() {
  let next = 1;
  const queue = new Map<number, (time: number) => void>();
  let now = 0;
  const scheduler: FrameScheduler = {
    request(callback) {
      const id = next++;
      queue.set(id, callback);
      return id;
    },
    cancel(id) {
      queue.delete(id);
    },
  };
  return {
    scheduler,
    get pending() {
      return queue.size;
    },
    /** Runs one frame `ms` after the previous one. */
    frame(ms = 16) {
      now += ms;
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback(now);
    },
    /** Runs frames until nothing is queued, with a cap so a bug can't hang the test. */
    runToRest(ms = 16, cap = 1000) {
      let frames = 0;
      while (queue.size > 0 && frames < cap) {
        this.frame(ms);
        frames++;
      }
      return frames;
    },
  };
}

function makeSpring(value = 0, reduced = false) {
  const frames = manualFrames();
  const updates: number[] = [];
  const spring = new Spring({
    value,
    onUpdate: (v) => updates.push(v),
    scheduler: frames.scheduler,
    reducedMotion: () => reduced,
  });
  return { spring, frames, updates };
}

describe("stepSpring", () => {
  it("moves toward the target and slows down as it arrives", () => {
    let state = { value: 0, velocity: 0 };
    const seen: number[] = [];
    for (let i = 0; i < 60; i++) {
      state = stepSpring(state, 100, 1 / 60);
      seen.push(state.value);
    }
    // Monotonic: critically damped means no overshoot from rest.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(100);
    expect(seen[seen.length - 1]).toBeGreaterThan(99);
  });

  it("does not depend on how the time is cut into frames", () => {
    let fine = { value: 0, velocity: 500 };
    for (let i = 0; i < 10; i++) fine = stepSpring(fine, 200, 0.01);
    const coarse = stepSpring({ value: 0, velocity: 500 }, 200, 0.1);
    expect(fine.value).toBeCloseTo(coarse.value, 6);
    expect(fine.velocity).toBeCloseTo(coarse.velocity, 6);
  });

  it("keeps the velocity it is given at the first instant", () => {
    const next = stepSpring({ value: 0, velocity: 1000 }, 0, 0.001);
    expect(next.value).toBeGreaterThan(0);
    expect(next.velocity).toBeGreaterThan(900);
  });
});

describe("Spring", () => {
  it("settles exactly on the target and calls onRest once", () => {
    const { spring, frames, updates } = makeSpring(0);
    const onRest = vi.fn();
    spring.to(300, { onRest });
    frames.runToRest();
    expect(spring.value).toBe(300);
    expect(spring.velocity).toBe(0);
    expect(spring.isAnimating).toBe(false);
    expect(updates[updates.length - 1]).toBe(300);
    expect(onRest).toHaveBeenCalledTimes(1);
  });

  it("continues from a given velocity", () => {
    const { spring, frames } = makeSpring(0);
    // Thrown downward hard toward a target behind it: it first keeps going.
    spring.to(0, { velocity: 2000 });
    frames.frame();
    frames.frame();
    expect(spring.value).toBeGreaterThan(0);
    frames.runToRest();
    expect(spring.value).toBe(0);
  });

  it("re-targets mid-flight without a jump in position or velocity", () => {
    const { spring, frames, updates } = makeSpring(0);
    spring.to(400);
    for (let i = 0; i < 6; i++) frames.frame();
    const valueBefore = spring.value;
    const velocityBefore = spring.velocity;
    expect(velocityBefore).toBeGreaterThan(0);

    spring.to(0);
    // Retargeting itself moves nothing.
    expect(spring.value).toBe(valueBefore);
    expect(spring.velocity).toBe(velocityBefore);

    // The next frame continues smoothly: still heading the old way for a moment.
    frames.frame();
    expect(Math.abs(spring.value - valueBefore)).toBeLessThan(Math.abs(velocityBefore) * 0.032);
    expect(spring.value).toBeGreaterThan(valueBefore);

    frames.runToRest();
    expect(spring.value).toBe(0);
    // No step in the reported values anywhere along the way.
    for (let i = 1; i < updates.length; i++) {
      expect(Math.abs(updates[i] - updates[i - 1])).toBeLessThan(60);
    }
  });

  it("drops the previous run's onRest when re-targeted", () => {
    const { spring, frames } = makeSpring(0);
    const first = vi.fn();
    const second = vi.fn();
    spring.to(200, { onRest: first });
    frames.frame();
    frames.frame();
    spring.to(0, { onRest: second });
    frames.runToRest();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stop cancels the frame, keeps the value and never calls onRest", () => {
    const { spring, frames } = makeSpring(0);
    const onRest = vi.fn();
    spring.to(200, { onRest });
    frames.frame();
    frames.frame();
    const where = spring.value;
    spring.stop();
    expect(frames.pending).toBe(0);
    expect(spring.value).toBe(where);
    expect(spring.velocity).toBe(0);
    frames.runToRest();
    expect(onRest).not.toHaveBeenCalled();
  });

  it("jump moves the value at once and stops any run", () => {
    const { spring, frames, updates } = makeSpring(0);
    spring.to(200);
    frames.frame();
    spring.jump(50);
    expect(spring.value).toBe(50);
    expect(updates[updates.length - 1]).toBe(50);
    expect(frames.pending).toBe(0);
  });

  it("rests at once, without a frame, when already at the target", () => {
    const { spring, frames } = makeSpring(120);
    const onRest = vi.fn();
    spring.to(120, { onRest });
    expect(onRest).toHaveBeenCalledTimes(1);
    expect(frames.pending).toBe(0);
  });

  it("jumps to the target under reduced motion instead of travelling", () => {
    const { spring, frames, updates } = makeSpring(0, true);
    const onRest = vi.fn();
    spring.to(300, { velocity: 5000, onRest });
    expect(frames.pending).toBe(0);
    expect(spring.value).toBe(300);
    expect(spring.velocity).toBe(0);
    expect(updates).toEqual([300]);
    expect(onRest).toHaveBeenCalledTimes(1);
  });

  it("asks the OS setting by default", () => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }),
    });
    try {
      const updates: number[] = [];
      const spring = new Spring({
        onUpdate: (v) => updates.push(v),
        scheduler: manualFrames().scheduler,
      });
      spring.to(80);
      expect(spring.value).toBe(80);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses requestAnimationFrame when no scheduler is given", () => {
    const request = vi.fn(() => 7);
    const cancel = vi.fn();
    vi.stubGlobal("window", {
      requestAnimationFrame: request,
      cancelAnimationFrame: cancel,
      matchMedia: () => ({ matches: false }),
    });
    try {
      const spring = new Spring({ onUpdate: () => {} });
      spring.to(100);
      expect(request).toHaveBeenCalledTimes(1);
      spring.stop();
      expect(cancel).toHaveBeenCalledWith(7);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clamps a late frame so the motion continues instead of leaping", () => {
    const { spring, frames } = makeSpring(0);
    spring.to(1000);
    frames.frame();
    frames.frame(5000);
    // One clamped step covers far less than the whole distance.
    expect(spring.value).toBeLessThan(500);
  });
});

describe("releaseVelocity", () => {
  it("measures units per second over the recent samples", () => {
    const samples = [
      { position: 0, time: 0 },
      { position: 10, time: 10 },
      { position: 40, time: 40 },
    ];
    expect(releaseVelocity(samples, 45)).toBe(1000);
  });

  it("is zero when the finger paused before lifting", () => {
    const samples = [
      { position: 0, time: 0 },
      { position: 40, time: 40 },
    ];
    expect(releaseVelocity(samples, 40 + 81)).toBe(0);
    expect(releaseVelocity(samples, 40 + 80)).toBe(1000);
  });

  it("is zero with nothing to measure", () => {
    expect(releaseVelocity([], 0)).toBe(0);
    expect(releaseVelocity([{ position: 5, time: 3 }], 3)).toBe(0);
    expect(
      releaseVelocity(
        [
          { position: 0, time: 3 },
          { position: 9, time: 3 },
        ],
        3,
      ),
    ).toBe(0);
  });

  it("keeps only the most recent samples", () => {
    let samples: { position: number; time: number }[] = [];
    for (let i = 0; i < 9; i++) samples = addPointerSample(samples, { position: i, time: i });
    expect(samples).toHaveLength(MAX_POINTER_SAMPLES);
    expect(samples[0].position).toBe(9 - MAX_POINTER_SAMPLES);
  });
});

describe("projectRest", () => {
  it("is where the drag stopped when there is no velocity", () => {
    expect(projectRest(120, 0)).toBe(120);
  });

  it("carries a throw further in the direction it is heading", () => {
    const down = projectRest(100, 1000);
    const up = projectRest(100, -1000);
    expect(down).toBeGreaterThan(100);
    expect(up).toBeLessThan(100);
    expect(down - 100).toBeCloseTo(100 - up, 6);
  });

  it("matches the approved prototype's numbers", () => {
    // prototype.html: x + ((v / 1000) * 0.998) / (1 - 0.998) * 0.25
    expect(projectRest(0, 1000)).toBeCloseTo(124.75, 6);
  });
});

describe("rubberBand", () => {
  it("follows less the further it is pulled, and keeps the sign", () => {
    expect(rubberBand(0)).toBe(0);
    const near = rubberBand(20);
    const far = rubberBand(400);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(20);
    expect(far / 400).toBeLessThan(near / 20);
    expect(rubberBand(-20)).toBeCloseTo(-near, 9);
  });
});
