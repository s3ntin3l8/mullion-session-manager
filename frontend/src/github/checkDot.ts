import { legacyDotClass, statusTone } from "../lib/statusTone.js";

export type DotClass = "good" | "bad" | "pending" | "none";

export function checkDotClass(status: string, conclusion: string | null): DotClass {
  return legacyDotClass(statusTone({ status, conclusion }));
}
