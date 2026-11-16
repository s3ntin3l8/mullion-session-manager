// Storage-cleanup types, kept out of types.ts (which is at its size ceiling).

export interface AndroidImagesStatus {
  available: boolean;
  /** SDK system images no AVD refers to (what the opt-in would uninstall). */
  images: Array<{ packagePath: string; bytes: number }>;
  reclaimableBytes: number;
  /** Why nothing is offered, when `available` is false. */
  error?: string;
}

export type CleanupSource =
  "docker" | "temp" | "caches" | "opencode" | "worktrees" | "android-images";
