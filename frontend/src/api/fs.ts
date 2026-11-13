import { request } from "./client.js";

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  truncated: boolean;
}

export const fsApi = {
  /** `hostId` lists that host's filesystem instead of the primary's. */
  listDirectories: (path: string, opts?: { hidden?: boolean; hostId?: string }) =>
    request<DirectoryListing>(
      `/api/fs/dirs?path=${encodeURIComponent(path)}${opts?.hidden ? "&hidden=1" : ""}${
        opts?.hostId ? `&hostId=${encodeURIComponent(opts.hostId)}` : ""
      }`,
    ),
};
