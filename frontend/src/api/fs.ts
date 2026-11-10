import { request } from "./client.js";

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  truncated: boolean;
}

export const fsApi = {
  listDirectories: (path: string) =>
    request<DirectoryListing>(`/api/fs/dirs?path=${encodeURIComponent(path)}`),
};
