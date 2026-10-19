/**
 * Parses ffmpeg `freezedetect` output (stderr) into the time the video last
 * changed: the start of the freeze that runs to the end of the video. Returns
 * null when the video never settles (no trailing freeze). Run with a noise
 * threshold the terminal's cursor doesn't cross, so a finished transcript
 * counts as frozen.
 */
export function lastChangeSeconds(freezeLog) {
  let start = null;
  for (const line of freezeLog.split("\n")) {
    const m = /lavfi\.freezedetect\.freeze_(start|end): ([\d.]+)/.exec(line);
    if (m) start = m[1] === "start" ? Number(m[2]) : null;
  }
  return start;
}
