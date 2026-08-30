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
