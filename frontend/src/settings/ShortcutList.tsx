import { Fragment } from "react";
import { SHORTCUTS, shortcutLabels } from "../lib/shortcutCatalog.js";
import type { ShortcutScope } from "../lib/shortcutCatalog.js";
import { Eyebrow, Row } from "../ui/primitives.js";

// Settings → Keyboard & input. Renders SHORTCUTS rather than its own copy
// of the chords: shortcutLabels reads the same bindings matchShortcut does,
// so the chips cannot describe a key the listener no longer fires. A
// fragment, not a wrapper — `.settings-row:last-child` is how the section
// drops the final divider, and a wrapper would make that rule fire at the
// end of each group instead.
const GROUPS: Array<{ scope: ShortcutScope; title: string; desc: string }> = [
  {
    scope: "app",
    title: "Keyboard shortcuts",
    desc: "These work anywhere, except when a focused terminal takes the chord.",
  },
  {
    scope: "terminal",
    title: "In a terminal",
    desc: "Only while a terminal pane is focused.",
  },
];

export function ShortcutList({ voiceHotkey }: { voiceHotkey: string }) {
  return (
    <>
      {GROUPS.map((group) => (
        <Fragment key={group.scope}>
          <Eyebrow title={group.title} desc={group.desc} />
          {SHORTCUTS.filter((shortcut) => shortcut.scope === group.scope).map((shortcut) => (
            <Row key={shortcut.id} label={shortcut.action} desc={shortcut.detail}>
              <span className="shortcut-chord-group">
                {shortcutLabels(shortcut, voiceHotkey).map((label) => (
                  <span key={label} className="settings-kbd-chip">
                    {label}
                  </span>
                ))}
              </span>
            </Row>
          ))}
        </Fragment>
      ))}
    </>
  );
}
