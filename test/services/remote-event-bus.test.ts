import { describe, expect, it, vi } from "vitest";
import { RemoteEventBus } from "../../src/services/remote-event-bus.js";
import type { NotificationEvent } from "../../src/services/pty-manager.js";

const event = (sessionId: number, seq = 1): NotificationEvent =>
  ({ sessionId, seq, kind: "status_change", ts: 1, payload: {} }) as NotificationEvent;

describe("RemoteEventBus (#2125)", () => {
  it("delivers to every subscriber until they unsubscribe", () => {
    const bus = new RemoteEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.subscribe(a);
    bus.subscribe(b);
    expect(bus.size).toBe(2);
    bus.publish(event(1));
    offA();
    bus.publish(event(2));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(bus.size).toBe(1);
  });

  it("reports demand only when the first listener arrives and the last leaves", () => {
    const onDemandChange = vi.fn();
    const bus = new RemoteEventBus(onDemandChange);
    const offA = bus.subscribe(vi.fn());
    const offB = bus.subscribe(vi.fn());
    expect(onDemandChange).toHaveBeenCalledTimes(1);
    offA();
    expect(onDemandChange).toHaveBeenCalledTimes(1);
    offB();
    offB(); // a second call is a no-op
    expect(onDemandChange).toHaveBeenCalledTimes(2);
  });

  it("a failing demand callback never breaks subscribe or unsubscribe", () => {
    const bus = new RemoteEventBus(() => {
      throw new Error("host list unreadable");
    });
    let off: () => void = () => {};
    expect(() => {
      off = bus.subscribe(vi.fn());
    }).not.toThrow();
    expect(bus.size).toBe(1);
    expect(() => off()).not.toThrow();
    expect(bus.size).toBe(0);
  });

  it("a throwing subscriber does not stop the others or the publisher", () => {
    const bus = new RemoteEventBus();
    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error("broken stream");
    });
    bus.subscribe(after);
    expect(() => bus.publish(event(1))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
