// The house spring (docs/motion.md): one critically damped spring for anything
// a finger can move, plus the two pure helpers a drag needs to hand its motion
// over to it (the release velocity and where a throw would come to rest).
//
// Framework-free on purpose: no React, no dependency. A Spring animates one
// number and reports it through `onUpdate`; the caller decides what the number
// means (a translateY, an opacity). Every run starts from the spring's current
// value AND current velocity, so a sheet can be caught mid-flight, dragged,
// thrown, or sent back the other way without a jump in position or speed.
//
// Time comes only from the timestamps the frame scheduler hands to its
// callbacks (requestAnimationFrame's own argument), never from a clock read
// here, so a test drives the spring by calling the queued callbacks with the
// times it chooses. `stepSpring` is the pure core, for tests that want no
// scheduler at all.

import { prefersReducedMotion } from "./motion.js";

/** The approved response: about 0.36s from rest to rest, no bounce. */
export const SPRING_RESPONSE_S = 0.36;

/**
 * The longest step one frame may integrate. A frame that arrives late (a busy
 * main thread, a tab coming back from the background) continues the motion
 * from where it was instead of jumping most of the way at once.
 */
const MAX_FRAME_S = 0.032;
const FIRST_FRAME_S = 1 / 60;

export interface SpringState {
  value: number;
  /** Units per second. */
  velocity: number;
}

/**
 * Advances a critically damped spring by `dt` seconds toward `target`, using
 * the closed-form solution rather than a numerical step, so the result does
 * not depend on the frame rate.
 *
 * With x the distance from the target and ω = 2π / response:
 *   x(t) = (x0 + (v0 + ω·x0)·t)·e^(−ωt)
 *   v(t) = (v0 − ω·t·(v0 + ω·x0))·e^(−ωt)
 */
export function stepSpring(
  state: SpringState,
  target: number,
  dt: number,
  response: number = SPRING_RESPONSE_S,
): SpringState {
  const omega = (2 * Math.PI) / response;
  const x0 = state.value - target;
  const v0 = state.velocity;
  const decay = Math.exp(-omega * dt);
  const b = v0 + omega * x0;
  return {
    value: target + (x0 + b * dt) * decay,
    velocity: (v0 - omega * dt * b) * decay,
  };
}

export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

// Resolved at call time, not at import: the lib tests run in node, which has
// no requestAnimationFrame, and a component test can stub it per test.
const animationFrames: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

export interface SpringOptions {
  /** Where the value starts. Defaults to 0. */
  value?: number;
  /** Called with every new value, including the final one at rest. */
  onUpdate: (value: number) => void;
  response?: number;
  /** Closer than this to the target (in the value's own units) counts as arrived. */
  restDistance?: number;
  /** Slower than this (units per second) counts as stopped. */
  restSpeed?: number;
  scheduler?: FrameScheduler;
  /** Whether to jump instead of travelling. Defaults to the OS setting. */
  reducedMotion?: () => boolean;
}

export interface SpringRunOptions {
  /** Replaces the current velocity, for a run that starts from a released drag. */
  velocity?: number;
  /** Called once this run reaches the target. A later `to`, `jump` or `stop` drops it. */
  onRest?: () => void;
}

export class Spring {
  private current: number;
  private speed = 0;
  private goal: number;
  private frame: number | null = null;
  private lastTime: number | null = null;
  private restCallback: (() => void) | undefined;
  private readonly onUpdate: (value: number) => void;
  private readonly response: number;
  private readonly restDistance: number;
  private readonly restSpeed: number;
  private readonly scheduler: FrameScheduler;
  private readonly reducedMotion: () => boolean;

  constructor(options: SpringOptions) {
    this.current = options.value ?? 0;
    this.goal = this.current;
    this.onUpdate = options.onUpdate;
    this.response = options.response ?? SPRING_RESPONSE_S;
    // Pixel-scaled defaults, as in the approved prototype.
    this.restDistance = options.restDistance ?? 0.5;
    this.restSpeed = options.restSpeed ?? 8;
    this.scheduler = options.scheduler ?? animationFrames;
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion;
  }

  get value(): number {
    return this.current;
  }

  get velocity(): number {
    return this.speed;
  }

  get target(): number {
    return this.goal;
  }

  get isAnimating(): boolean {
    return this.frame !== null;
  }

  /**
   * Animates to `target` from the current value and velocity. Under reduced
   * motion it jumps there instead and comes to rest at once; a caller that
   * wants something softer than a jump plays a short fade of its own.
   */
  to(target: number, options: SpringRunOptions = {}): void {
    this.goal = target;
    this.restCallback = options.onRest;
    if (options.velocity !== undefined) this.speed = options.velocity;
    if (this.reducedMotion() || this.isSettled()) {
      this.settle();
      return;
    }
    if (this.frame === null) {
      this.lastTime = null;
      this.frame = this.scheduler.request(this.tick);
    }
  }

  /** Puts the value somewhere without animating (a finger dragging it), and stops. */
  jump(value: number): void {
    this.cancelFrame();
    this.restCallback = undefined;
    this.current = value;
    this.goal = value;
    this.speed = 0;
    this.onUpdate(value);
  }

  /** Stops where it is, keeping the value. The run's `onRest` is not called. */
  stop(): void {
    this.cancelFrame();
    this.restCallback = undefined;
    this.goal = this.current;
    this.speed = 0;
  }

  private readonly tick = (time: number): void => {
    this.frame = null;
    // The first frame of a run has no previous timestamp to measure from; it
    // counts as one nominal frame, so a released throw keeps moving on the
    // very next frame instead of holding still for one.
    const dt =
      this.lastTime === null
        ? FIRST_FRAME_S
        : Math.min(MAX_FRAME_S, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;
    if (dt > 0) {
      const next = stepSpring(
        { value: this.current, velocity: this.speed },
        this.goal,
        dt,
        this.response,
      );
      this.current = next.value;
      this.speed = next.velocity;
    }
    if (this.isSettled()) {
      this.settle();
      return;
    }
    this.onUpdate(this.current);
    this.frame = this.scheduler.request(this.tick);
  };

  private isSettled(): boolean {
    return (
      Math.abs(this.current - this.goal) < this.restDistance &&
      Math.abs(this.speed) < this.restSpeed
    );
  }

  private settle(): void {
    this.cancelFrame();
    this.current = this.goal;
    this.speed = 0;
    this.onUpdate(this.current);
    const done = this.restCallback;
    this.restCallback = undefined;
    done?.();
  }

  private cancelFrame(): void {
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
  }
}

/** One pointer position along the drag's axis, with its event timestamp in ms. */
export interface PointerSample {
  position: number;
  time: number;
}

/** How many recent samples a drag keeps for its release velocity. */
export const MAX_POINTER_SAMPLES = 5;

/**
 * A finger that rested longer than this before lifting hands over no speed:
 * the drag was placed, not thrown.
 */
export const STILL_BEFORE_RELEASE_MS = 80;

/** Appends a sample, keeping only the most recent `MAX_POINTER_SAMPLES`. */
export function addPointerSample(samples: PointerSample[], sample: PointerSample): PointerSample[] {
  const next = [...samples, sample];
  return next.length > MAX_POINTER_SAMPLES ? next.slice(-MAX_POINTER_SAMPLES) : next;
}

/**
 * The velocity (units per second) a drag hands to the spring on release,
 * measured over the recent samples. Zero when the finger paused for more
 * than `stillMs` before lifting, or when there is nothing to measure.
 */
export function releaseVelocity(
  samples: readonly PointerSample[],
  releaseTime: number,
  stillMs: number = STILL_BEFORE_RELEASE_MS,
): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (releaseTime - last.time > stillMs) return 0;
  const span = last.time - first.time;
  if (span <= 0) return 0;
  return ((last.position - first.position) / span) * 1000;
}

/** The deceleration rate of a normal scroll, per millisecond. */
export const THROW_DECELERATION = 0.998;
/**
 * How much of a free scroll's glide a throw counts for. The approved
 * prototype used a quarter: a whole glide makes every flick dismiss.
 */
export const THROW_WEIGHT = 0.25;

/**
 * Where a throw released at `position` with `velocity` (units per second)
 * would come to rest. Drag gestures decide from this, not from where the
 * finger lifted, so a short fast flick counts as much as a long slow drag.
 */
export function projectRest(
  position: number,
  velocity: number,
  deceleration: number = THROW_DECELERATION,
  weight: number = THROW_WEIGHT,
): number {
  return position + ((velocity / 1000) * deceleration * weight) / (1 - deceleration);
}

/**
 * Resistance for a drag past the edge it may move toward: the further the
 * finger goes, the less the content follows. Keeps the sign of `distance`.
 */
export function rubberBand(distance: number, dimension = 300, constant = 0.55): number {
  const d = Math.abs(distance);
  const resisted = (d * constant * dimension) / (dimension + constant * d);
  return Math.sign(distance) * resisted;
}
