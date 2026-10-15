// A fake opencode v2 plugin `Context` (the object handed to a plugin's
// `setup(ctx)`), exposing only the slices opencode-plugin.js uses:
// `ctx.event.subscribe`, `ctx.tool.transform`/`hook`, `ctx.session.hook`,
// `ctx.location`. Event delivery is driven by the test via `push()`, and the
// stream ends when the plugin aborts its signal — mirroring how the real
// subscription behaves on plugin unload.

export interface FakeRegistration {
  dispose: () => Promise<void>;
  disposed: boolean;
}

export interface FakeTool {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: { signal: AbortSignal }) => Promise<{ content: string }>;
}

export function createFakeCtx(directory = "/work/dir") {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let subscribeSignal: AbortSignal | undefined;
  const registrations: FakeRegistration[] = [];
  const tools: FakeTool[] = [];
  const toolHooks = new Map<string, (event: unknown) => unknown>();
  const sessionHooks = new Map<string, (event: unknown) => unknown>();
  const permissionReplies: Array<{
    sessionID: string;
    requestID: string;
    decision: string;
    message?: string;
  }> = [];
  let diffResult: unknown = [];
  const diffCalls: unknown[] = [];

  const registration = (): FakeRegistration => {
    const reg: FakeRegistration = {
      disposed: false,
      dispose: async () => {
        reg.disposed = true;
      },
    };
    registrations.push(reg);
    return reg;
  };

  const ctx = {
    location: { directory },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
        subscribeSignal = signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<unknown>> {
                for (;;) {
                  if (queue.length > 0) return { value: queue.shift(), done: false };
                  if (signal?.aborted) return { value: undefined, done: true };
                  await new Promise<void>((resolve) => {
                    wake = resolve;
                    signal?.addEventListener("abort", () => resolve(), { once: true });
                  });
                }
              },
            };
          },
        };
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: FakeTool) => void }) => void) => {
        callback({ add: (tool) => tools.push(tool) });
        return registration();
      },
      hook: async (name: string, callback: (event: unknown) => unknown) => {
        toolHooks.set(name, callback);
        return registration();
      },
    },
    permission: {
      reply: async (input: {
        sessionID: string;
        requestID: string;
        decision: string;
        message?: string;
      }) => {
        permissionReplies.push(input);
      },
    },
    vcs: {
      diff: async (input: unknown) => {
        diffCalls.push(input);
        if (diffResult instanceof Error) throw diffResult;
        return diffResult;
      },
    },
    session: {
      hook: async (name: string, callback: (event: unknown) => unknown) => {
        sessionHooks.set(name, callback);
        return registration();
      },
    },
  };

  return {
    ctx,
    tools,
    toolHooks,
    sessionHooks,
    permissionReplies,
    diffCalls,
    setDiffResult(result: unknown) {
      diffResult = result;
    },
    registrations,
    /** Delivers one event to the plugin's subscription loop. */
    push(event: unknown) {
      queue.push(event);
      wake?.();
    },
    /** Whether the plugin aborted its event subscription. */
    get aborted() {
      return subscribeSignal?.aborted === true;
    },
    get subscribed() {
      return subscribeSignal !== undefined;
    },
  };
}

/** Lets the plugin's async subscription loop drain what `push()` queued. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}
