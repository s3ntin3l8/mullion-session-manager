import { Fragment, type ReactNode } from "react";
import { parseSimpleMarkdown, type MdBlock, type MdSpan } from "../lib/markdown.js";

// Issue #990 — the first markdown surface in this app (task.reviewFindings);
// no dangerouslySetInnerHTML, no HTML injection surface at all. Plain
// strings for `text` spans (not wrapped in a <span>) so a single-span line
// lands as one direct text-node child of its containing element, matching
// how @testing-library/dom's default text matcher walks the DOM.
function renderSpans(spans: MdSpan[], keyPrefix: string): ReactNode[] {
  return spans.map((span, i) => {
    if (span.type === "bold") return <strong key={`${keyPrefix}-${i}`}>{span.text}</strong>;
    if (span.type === "code") return <code key={`${keyPrefix}-${i}`}>{span.text}</code>;
    return span.text;
  });
}

type BulletBlock = Extract<MdBlock, { type: "bullet" }>;
type NonBulletBlock = Exclude<MdBlock, { type: "bullet" }>;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseSimpleMarkdown(text);
  // Group consecutive `bullet` blocks into one <ul> rather than one <ul>
  // per bullet.
  const groups: (NonBulletBlock | BulletBlock[])[] = [];
  for (const block of blocks) {
    if (block.type === "bullet") {
      const last = groups[groups.length - 1];
      if (Array.isArray(last)) {
        last.push(block);
        continue;
      }
      groups.push([block]);
      continue;
    }
    groups.push(block);
  }

  return (
    <div className={className}>
      {groups.map((group, i) => {
        const key = `g-${i}`;
        if (Array.isArray(group)) {
          return (
            <ul key={key}>
              {group.map((bullet, bi) => (
                <li key={`${key}-${bi}`}>{renderSpans(bullet.spans, `${key}-${bi}`)}</li>
              ))}
            </ul>
          );
        }
        if (group.type === "heading") {
          return group.level === 2 ? (
            <h2 key={key}>{renderSpans(group.spans, key)}</h2>
          ) : (
            <h3 key={key}>{renderSpans(group.spans, key)}</h3>
          );
        }
        // "break" renders nothing — it only exists to stop the grouping
        // loop above from re-joining two bullet runs the source separated
        // with a blank line into one <ul>. See markdown.ts's own comment.
        if (group.type === "break") return null;
        return (
          <p key={key}>
            {group.lines.map((line, li) => (
              <Fragment key={`${key}-l${li}`}>
                {renderSpans(line, `${key}-l${li}`)}
                {li < group.lines.length - 1 ? <br /> : null}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
