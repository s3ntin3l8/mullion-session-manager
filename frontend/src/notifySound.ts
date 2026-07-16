import type { SoundName } from "./api.js";

// Settings -> Notifications & status' "Sound" channel — three short
// programmatic tones (Web Audio oscillator beeps) rather than shipping
// audio asset files for a feature this small. Best-effort: browsers gate
// AudioContext behind a user-gesture requirement, so a session that fires
// before the user has ever clicked anywhere in the tab may silently no-op —
// acceptable for a secondary notification channel that always has the
// browser-notification channel alongside it.
const TONES: Record<SoundName, number[]> = {
  ping: [880],
  chime: [660, 990],
  blip: [440],
};

export function playNotificationSound(name: SoundName): void {
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const now = ctx.currentTime;

    let t = now;
    for (const freq of TONES[name]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
      t += 0.12;
    }
    setTimeout(() => void ctx.close(), 500);
  } catch {
    // Sound is a secondary channel — never let it throw into a caller's
    // notification-handling effect.
  }
}
