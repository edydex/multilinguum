import type { TranscriptSegment } from '@multilinguum/protocol';

export interface CaptionTimeline {
  sessionId?: string;
  final: TranscriptSegment[];
  live?: TranscriptSegment;
}

export function mergeCaption(
  current: CaptionTimeline | undefined,
  segment: TranscriptSegment,
): CaptionTimeline {
  const existing =
    current?.sessionId === segment.sessionId
      ? current
      : { sessionId: segment.sessionId, final: [] };
  if (!segment.final) {
    if ((existing.final.at(-1)?.sequence ?? -1) >= segment.sequence) return existing;
    if ((existing.live?.sequence ?? -1) > segment.sequence) return existing;
    if (
      existing.live?.sequence === segment.sequence &&
      (existing.live.revision ?? 0) > (segment.revision ?? 0)
    ) {
      return existing;
    }
    return { ...existing, live: segment };
  }
  const final = [...existing.final.filter((item) => item.sequence !== segment.sequence), segment]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-160);
  return {
    sessionId: segment.sessionId,
    final,
    ...(existing.live && existing.live.sequence > segment.sequence ? { live: existing.live } : {}),
  };
}

export function captionWordState(
  startAtUnixMs: number,
  endAtUnixMs: number,
  now: number,
): 'future' | 'current' | 'spoken' {
  if (now < startAtUnixMs) return 'future';
  if (now < endAtUnixMs) return 'current';
  return 'spoken';
}

export function visibleCaptionSegments(
  segments: TranscriptSegment[],
  now: number,
  leadMs = 1_800,
): TranscriptSegment[] {
  return segments.filter(
    (segment) => !segment.playout || segment.playout.startAtUnixMs <= now + leadMs,
  );
}

/** The latest caption whose audio has actually begun, never merely the newest queued text. */
export function narratedAnchorSequence(
  segments: TranscriptSegment[],
  now: number,
): number | undefined {
  let anchor: number | undefined;
  for (const segment of segments) {
    if (!segment.playout || segment.playout.startAtUnixMs <= now) anchor = segment.sequence;
    if (
      segment.playout &&
      segment.playout.startAtUnixMs <= now &&
      segment.playout.endAtUnixMs > now
    ) {
      return segment.sequence;
    }
  }
  return anchor;
}
