import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.js";
import { attachLocalEventsSocket } from "../../src/routes/events.js";
import { projects, sessionEvents, sessions } from "../../src/db/schema.js";
import { publishVerifiedRemoteEvent } from "../../src/services/event-store.js";
import type { SocketLike } from "../../src/services/socket-channel.js";
import type { NotificationEvent } from "../../src/services/pty-manager.js";

function fakeSocket(): { socket: SocketLike; sent: NotificationEvent[]; close: () => void } {
  const sent: NotificationEvent[] = [];
  let onClose: (() => void) | undefined;
  const socket: SocketLike = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: (data) => void sent.push(JSON.parse(String(data))),
    close: () => {},
    on: ((event: string, listener: () => void) => {
      if (event === "close") onClose = listener;
    }) as SocketLike["on"],
  };
  return { socket, sent, close: () => onClose?.() };
}

const remoteEvent = (sessionId: number, seq: number): NotificationEvent =>
  ({
    sessionId,
    seq,
    kind: "status_change",
    ts: Date.now(),
    payload: { phase: "done" },
  }) as NotificationEvent;

describe("attachLocalEventsSocket with includeRemote (#2125)", () => {
  async function setup() {
    const app = await buildTestApp();
    await app.ready();
    const projectId = Number(
      app.db.insert(projects).values({ name: "p", cwd: "/tmp/p" }).run().lastInsertRowid,
    );
    const add = () =>
      Number(
        app.db
          .insert(sessions)
          .values({ projectId, command: "bash", cwd: "/tmp/p", hostId: "remote-1" })
          .run().lastInsertRowid,
      );
    return { app, add };
  }

  it("streams a remote host's live events for the filtered session only", async () => {
    const { app, add } = await setup();
    const mine = add();
    const other = add();
    const { socket, sent } = fakeSocket();
    attachLocalEventsSocket(app, socket, {
      sessionIdFilter: String(mine),
      includeRemote: true,
      remoteReplayIds: [mine],
    });
    app.remoteEventBus!.publish(remoteEvent(mine, 1));
    app.remoteEventBus!.publish(remoteEvent(other, 1));
    expect(sent.map((e) => e.sessionId)).toEqual([mine]);
  });

  it("replays what was persisted for the named sessions before going live, without duplicates", async () => {
    const { app, add } = await setup();
    const mine = add();
    app.db
      .insert(sessionEvents)
      .values([
        { sessionId: mine, seq: 1, kind: "status_change", ts: 100, payload: "{}" },
        { sessionId: mine, seq: 2, kind: "title_change", ts: 200, payload: '{"title":"t"}' },
      ])
      .run();
    const { socket, sent } = fakeSocket();
    attachLocalEventsSocket(app, socket, {
      sessionIdFilter: String(mine),
      includeRemote: true,
      remoteReplayIds: [mine],
    });
    expect(sent.map((e) => [e.seq, e.kind])).toEqual([
      [1, "status_change"],
      [2, "title_change"],
    ]);
    // The same event arriving live after the replay is a second delivery the
    // clients de-duplicate by (sessionId, seq); a NEW one is simply appended.
    app.remoteEventBus!.publish(remoteEvent(mine, 3));
    expect(sent.at(-1)?.seq).toBe(3);
  });

  it("is opt-in: without includeRemote the remote feed is not heard", async () => {
    const { app, add } = await setup();
    const mine = add();
    const { socket, sent } = fakeSocket();
    attachLocalEventsSocket(app, socket, { sessionIdFilter: String(mine) });
    app.remoteEventBus!.publish(remoteEvent(mine, 1));
    expect(sent).toEqual([]);
  });

  it("stops listening when the stream closes", async () => {
    const { app, add } = await setup();
    const mine = add();
    const { socket, sent, close } = fakeSocket();
    attachLocalEventsSocket(app, socket, { includeRemote: true, remoteReplayIds: [mine] });
    expect(app.remoteEventBus!.size).toBe(1);
    close();
    expect(app.remoteEventBus!.size).toBe(0);
    app.remoteEventBus!.publish(remoteEvent(mine, 9));
    expect(sent).toEqual([]);
  });
});

describe("publishVerifiedRemoteEvent (#2125)", () => {
  it("publishes only what the reporting host owns, and nothing when nobody listens", async () => {
    const app = await buildTestApp();
    await app.ready();
    const projectId = Number(
      app.db.insert(projects).values({ name: "p", cwd: "/tmp/p" }).run().lastInsertRowid,
    );
    const onA = Number(
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: "/tmp/p", hostId: "host-a" })
        .run().lastInsertRowid,
    );
    const heard: NotificationEvent[] = [];
    const bus = app.remoteEventBus!;
    const event = remoteEvent(onA, 1);

    // Nobody listening: no work, no delivery.
    publishVerifiedRemoteEvent(app, bus, event, "host-a");
    bus.subscribe((e) => heard.push(e));
    // The owner reports it: delivered. Another enrolled host claiming the session: dropped.
    publishVerifiedRemoteEvent(app, bus, remoteEvent(onA, 2), "host-a");
    publishVerifiedRemoteEvent(app, bus, remoteEvent(onA, 3), "host-b");
    // A session that does not exist is dropped too.
    publishVerifiedRemoteEvent(app, bus, remoteEvent(999_999, 1), "host-a");
    expect(heard.map((e) => e.seq)).toEqual([2]);
    // A failing ownership read drops the event and never throws into the caller.
    const original = app.db.select.bind(app.db);
    app.db.select = (() => {
      throw new Error("db closed");
    }) as never;
    expect(() => publishVerifiedRemoteEvent(app, bus, remoteEvent(onA, 4), "host-a")).not.toThrow();
    app.db.select = original as never;
    expect(heard.map((e) => e.seq)).toEqual([2]);
    // The agent role has no bus at all.
    expect(() => publishVerifiedRemoteEvent(app, null, event, "host-a")).not.toThrow();
  });
});
