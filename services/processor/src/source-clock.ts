/** Rebase sample-relative offsets onto the capture clock, including a delayed microphone start. */
export function sourceClock(
  startMs: number,
  endMs: number,
  captureCompletedAtUnixMs: number | undefined,
  sessionStartedAt: string | undefined,
): { sourceStartAtUnixMs: number; sourceEndAtUnixMs: number } {
  const end =
    Number.isFinite(captureCompletedAtUnixMs) && captureCompletedAtUnixMs! > 0
      ? captureCompletedAtUnixMs!
      : Date.parse(sessionStartedAt ?? '') + endMs;
  return { sourceStartAtUnixMs: end - Math.max(0, endMs - startMs), sourceEndAtUnixMs: end };
}
