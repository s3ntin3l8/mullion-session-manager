import type { CreateAvdInput, CreateAvdResult, SystemImage } from "./avd-manager.js";

/** The client's `request`, bound. An omitted timeout means the client default. */
export type AvdRequest = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

export interface AvdsClientDeps {
  request: AvdRequest;
}

/** `avdmanager list avd` / `list device` have a 15 s agent-side timeout. */
const AVD_LIST_TIMEOUT_MS = 20_000;
/** `avdmanager create avd` has a 120 s agent-side timeout plus a 15 s
 * `avdmanager list avd` when `ramSize`/`dataPartitionSize` is set; leave
 * margin above that 135 s worst-case budget so the client never aborts a
 * create that just succeeded on the agent. */
const AVD_CREATE_TIMEOUT_MS = 150_000;

export function createAvdsClient({ request }: AvdsClientDeps) {
  return {
    async list(): Promise<string[]> {
      return (await request<{ avds: string[] }>("/internal/avds", undefined, AVD_LIST_TIMEOUT_MS))
        .avds;
    },

    async systemImages(): Promise<SystemImage[]> {
      return (await request<{ systemImages: SystemImage[] }>("/internal/system-images"))
        .systemImages;
    },

    async deviceProfiles(): Promise<string[]> {
      return (
        await request<{ deviceProfiles: string[] }>(
          "/internal/device-profiles",
          undefined,
          AVD_LIST_TIMEOUT_MS,
        )
      ).deviceProfiles;
    },

    create(input: CreateAvdInput): Promise<CreateAvdResult> {
      return request<CreateAvdResult>(
        "/internal/avds",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        AVD_CREATE_TIMEOUT_MS,
      );
    },
  };
}

export type AvdsClient = ReturnType<typeof createAvdsClient>;
