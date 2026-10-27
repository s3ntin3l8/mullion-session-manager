/** "8s", "1m 20s", "2h 5m": how long something took or has been running. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m ${totalSec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
