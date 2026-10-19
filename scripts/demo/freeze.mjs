/**
 * Parses ffmpeg `freezedetect` output (stderr) into the time the video last
 * changed: the start of the freeze that runs to the end of the video. Returns
 * null when the video never settles (no trailing freeze). Run with a noise
 * threshold the terminal's cursor doesn't cross, so a finished transcript
 * counts as frozen.
 *
 * Last event wins because freezedetect emits no `freeze_end` at EOF: a clip
 * that ends frozen logs a lone trailing `freeze_start` (ffmpeg 6.1). Treating
 * a start without an end as "unterminated" would break the cut.
 */
export function lastChangeSeconds(freezeLog) {
  let start = null;
  for (const line of freezeLog.split("\n")) {
    const m = /lavfi\.freezedetect\.freeze_(start|end): ([\d.]+)/.exec(line);
    if (m) start = m[1] === "start" ? Number(m[2]) : null;
  }
  return start;
}

/**
 * The `-to` input option that ends the loop `tailS` after its last on-screen
 * change, or no option (keep the whole recording) when there is none to cut
 * at. `-to` sits on the input's own timeline, the same one as `-ss`, and
 * ffmpeg aborts the encode if it isn't strictly after `-ss` ("-to value
 * smaller than -ss"), so a cut at or before `startS` is dropped too.
 */
export function loopEnd(lastChange, startS, tailS) {
  if (lastChange === null) return [];
  const end = lastChange + tailS;
  return end > startS ? ["-to", end.toFixed(2)] : [];
}
