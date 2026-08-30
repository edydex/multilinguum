import type { Language, PipelineLatencySample, TranscriptSegment } from '@multilinguum/protocol';

export interface ReviewWordTiming {
  text: string;
  audioStartMs: number;
  audioEndMs: number;
}

export interface ReviewTranscriptSegment extends TranscriptSegment {
  wordTimings?: ReviewWordTiming[];
}

export interface ReviewSegment extends ReviewTranscriptSegment {
  audioStartMs: number;
  audioEndMs: number;
}

export interface ReviewTrack {
  language: Language;
  channelId: string;
  audioUrl: string;
  segments: ReviewSegment[];
  durationMs: number;
}

export function parseJsonLines<T>(contents: string): T[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function buildReviewTrack(
  language: Language,
  channelId: string,
  audioUrl: string,
  transcript: ReviewTranscriptSegment[],
  latency: PipelineLatencySample[],
  sourceLanguage: Language,
): ReviewTrack {
  const ordered = transcript
    .filter((segment) => segment.final)
    .sort((a, b) => a.sequence - b.sequence);
  const samples = new Map(
    latency
      .filter((sample) => sample.channelId === channelId && sample.playout)
      .map((sample) => [sample.sequence, sample] as const),
  );
  let cursorMs = 0;
  const segments = ordered.map((segment) => {
    if (language === sourceLanguage) {
      return {
        ...segment,
        audioStartMs: segment.sourceStartMs,
        audioEndMs: Math.max(segment.sourceStartMs + 1, segment.sourceEndMs),
      };
    }
    const sample = samples.get(segment.sequence);
    const durationMs = sample?.playout
      ? Math.max(1, sample.playout.completedAtUnixMs - sample.playout.startedAtUnixMs)
      : Math.max(1, segment.sourceEndMs - segment.sourceStartMs);
    const reviewSegment = {
      ...segment,
      audioStartMs: cursorMs,
      audioEndMs: cursorMs + durationMs,
    };
    cursorMs += durationMs;
    return reviewSegment;
  });
  return {
    language,
    channelId,
    audioUrl,
    segments,
    durationMs:
      language === sourceLanguage
        ? Math.max(0, ...segments.map((segment) => segment.audioEndMs))
        : cursorMs,
  };
}

function segmentAtAudioTime(track: ReviewTrack, audioMs: number): ReviewSegment | undefined {
  return (
    track.segments.find(
      (segment) => audioMs >= segment.audioStartMs && audioMs < segment.audioEndMs,
    ) ??
    [...track.segments].reverse().find((segment) => audioMs >= segment.audioStartMs) ??
    track.segments[0]
  );
}

function segmentAtSourceTime(track: ReviewTrack, sourceMs: number): ReviewSegment | undefined {
  return (
    track.segments.find(
      (segment) => sourceMs >= segment.sourceStartMs && sourceMs < segment.sourceEndMs,
    ) ??
    [...track.segments].reverse().find((segment) => sourceMs >= segment.sourceStartMs) ??
    track.segments[0]
  );
}

function progress(value: number, start: number, end: number): number {
  if (end <= start) return 0;
  return Math.max(0, Math.min(1, (value - start) / (end - start)));
}

export function sourceTimeAtAudio(track: ReviewTrack, audioMs: number): number {
  const segment = segmentAtAudioTime(track, audioMs);
  if (!segment) return 0;
  const ratio = progress(audioMs, segment.audioStartMs, segment.audioEndMs);
  return segment.sourceStartMs + ratio * (segment.sourceEndMs - segment.sourceStartMs);
}

export function audioTimeAtSource(track: ReviewTrack, sourceMs: number): number {
  const segment = segmentAtSourceTime(track, sourceMs);
  if (!segment) return 0;
  const ratio = progress(sourceMs, segment.sourceStartMs, segment.sourceEndMs);
  return segment.audioStartMs + ratio * (segment.audioEndMs - segment.audioStartMs);
}

export function wordAudioTime(
  segment: ReviewSegment,
  wordIndex: number,
  wordCount: number,
): number {
  const measured = segment.wordTimings?.[wordIndex];
  if (measured) return measured.audioStartMs;
  if (wordCount <= 1) return segment.audioStartMs;
  const ratio = Math.max(0, Math.min(1, wordIndex / wordCount));
  return segment.audioStartMs + ratio * (segment.audioEndMs - segment.audioStartMs);
}

export function activeWordIndex(
  segment: ReviewSegment,
  audioMs: number,
  wordCount: number,
): number {
  if (segment.wordTimings?.length) {
    const exact = segment.wordTimings.findIndex(
      (word) => audioMs >= word.audioStartMs && audioMs < word.audioEndMs,
    );
    if (exact >= 0) return exact;
    const prior = [...segment.wordTimings]
      .reverse()
      .findIndex((word) => audioMs >= word.audioStartMs);
    return prior < 0 ? 0 : segment.wordTimings.length - 1 - prior;
  }
  if (wordCount <= 1) return 0;
  const ratio = progress(audioMs, segment.audioStartMs, segment.audioEndMs);
  return Math.min(wordCount - 1, Math.floor(ratio * wordCount));
}
