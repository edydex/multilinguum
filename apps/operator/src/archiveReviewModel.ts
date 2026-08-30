import type { Language, PipelineLatencySample, TranscriptSegment } from '@multilinguum/protocol';

export interface ReviewSegment extends TranscriptSegment {
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

export interface ReviewThoughtAnchor {
  id: string;
  label: string;
  sourceStartMs: number;
  sourceEndMs: number;
}

export interface ThoughtAlignedPosition {
  audioMs: number;
  sourceMs: number;
  anchor: ReviewThoughtAnchor | undefined;
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
  transcript: TranscriptSegment[],
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

function closesThought(text: string): boolean {
  const trimmed = text.trim();
  if (/(?:\.{2,}|…)["”’')\]]*$/u.test(trimmed)) return false;
  return /[.!?]["”’')\]]*$/u.test(trimmed);
}

function thoughtLabel(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93).trimEnd()}…` : normalized;
}

export function buildDefaultThoughtAnchors(segments: ReviewSegment[]): ReviewThoughtAnchor[] {
  const ordered = [...segments].sort((a, b) => a.sourceStartMs - b.sourceStartMs);
  const anchors: ReviewThoughtAnchor[] = [];
  let group: ReviewSegment[] = [];

  const finishGroup = () => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return;
    anchors.push({
      id: `thought-${first.sequence}-${last.sequence}`,
      label: thoughtLabel(group.map((segment) => segment.text).join(' ')),
      sourceStartMs: first.sourceStartMs,
      sourceEndMs: last.sourceEndMs,
    });
    group = [];
  };

  for (const segment of ordered) {
    group.push(segment);
    const groupStartMs = group[0]?.sourceStartMs ?? segment.sourceStartMs;
    if (closesThought(segment.text) || segment.sourceEndMs - groupStartMs >= 20_000) {
      finishGroup();
    }
  }
  finishGroup();
  return anchors;
}

export function thoughtAnchorAtSource(
  anchors: ReviewThoughtAnchor[],
  sourceMs: number,
): ReviewThoughtAnchor | undefined {
  return (
    anchors.find((anchor) => sourceMs >= anchor.sourceStartMs && sourceMs < anchor.sourceEndMs) ??
    [...anchors].reverse().find((anchor) => sourceMs >= anchor.sourceStartMs) ??
    anchors[0]
  );
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

export function thoughtAlignedAudioTime(
  currentTrack: ReviewTrack,
  nextTrack: ReviewTrack,
  currentAudioMs: number,
  anchors: ReviewThoughtAnchor[],
): ThoughtAlignedPosition {
  const exactSourceMs = sourceTimeAtAudio(currentTrack, currentAudioMs);
  const anchor = thoughtAnchorAtSource(anchors, exactSourceMs);
  const sourceMs = anchor?.sourceStartMs ?? exactSourceMs;
  return {
    audioMs: audioTimeAtSource(nextTrack, sourceMs),
    sourceMs,
    anchor,
  };
}

export function wordAudioTime(
  segment: ReviewSegment,
  wordIndex: number,
  wordCount: number,
): number {
  if (wordCount <= 1) return segment.audioStartMs;
  const ratio = Math.max(0, Math.min(1, wordIndex / wordCount));
  return segment.audioStartMs + ratio * (segment.audioEndMs - segment.audioStartMs);
}

export function activeWordIndex(
  segment: ReviewSegment,
  audioMs: number,
  wordCount: number,
): number {
  if (wordCount <= 1) return 0;
  const ratio = progress(audioMs, segment.audioStartMs, segment.audioEndMs);
  return Math.min(wordCount - 1, Math.floor(ratio * wordCount));
}
