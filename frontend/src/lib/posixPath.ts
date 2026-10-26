// Tiny POSIX path helpers for the browser (no node:path here). All inputs are
// absolute, `/`-separated paths as the backend reports them.

/** Collapses `.`, `..` and repeated or trailing slashes. */
export function normalizeAbs(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** `to` relative to `from` (both absolute); `.`-free, may start with `../`. */
export function relativeAbs(from: string, to: string): string {
  const a = normalizeAbs(from).split("/").filter(Boolean);
  const b = normalizeAbs(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

export function joinAbs(root: string, rel: string): string {
  return rel === "" ? normalizeAbs(root) : normalizeAbs(`${root}/${rel}`);
}

/** True when `child` is `root` itself or lies under it. */
export function isWithin(root: string, child: string): boolean {
  const r = normalizeAbs(root);
  const c = normalizeAbs(child);
  return c === r || c.startsWith(r === "/" ? "/" : `${r}/`);
}
