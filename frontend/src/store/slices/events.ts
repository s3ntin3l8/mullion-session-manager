import type { StateCreator } from "zustand";
import { connectEventsStream, type EventsClientHandle } from "../../eventsClient.js";
import { addEvent, eventKey } from "../helpers.js";
import type { DashboardState, EventsSlice } from "../types.js";

export const createEventsSlice: StateCreator<DashboardState, [], [], EventsSlice> = (set, _get) => {
  // Set once startEventsStream() connects (App.tsx's mount effect) — the
  // handle markEventSeen() below sends "seen" messages through. Stays null
  // until then (and after cleanup), matching eventsClient.ts's own
  // "no-op while disconnected" semantics rather than throwing.
  let eventsClientHandle: EventsClientHandle | null = null;

  return {
    events: {},
    lastSeenSeq: {},
    dismissedEventKeys: {},

    startEventsStream: () => {
      const handle = connectEventsStream((event) => {
        set((state) => ({ events: addEvent(state.events, event) }));
      });
      eventsClientHandle = handle;
      return () => {
        handle.close();
        if (eventsClientHandle === handle) eventsClientHandle = null;
      };
    },

    markEventSeen: (sessionId, seq) => {
      set((state) => {
        const current = state.lastSeenSeq[sessionId] ?? 0;
        if (seq <= current) return state;
        return { lastSeenSeq: { ...state.lastSeenSeq, [sessionId]: seq } };
      });
      eventsClientHandle?.sendSeen(sessionId, seq);
    },

    dismissEvent: (sessionId, seq) => {
      set((state) => ({
        dismissedEventKeys: { ...state.dismissedEventKeys, [eventKey(sessionId, seq)]: true },
      }));
    },
  };
};
