import { describe, expect, it } from 'vitest';
import type { PipelineLatencySample, TranscriptSegment } from '@multilinguum/protocol';
import {
  activeWordIndex,
  audioTimeAtSource,
  buildReviewTrack,
  parseJsonLines,
  sourceTimeAtAudio,
  wordAudioTime,
} from './archiveReviewModel';

const transcript: TranscriptSegment[] = [
  {
    id: 'a',
    sessionId: 'session',
    channelId: 'channel-en',
    language: 'en',
    text: 'What? How? Why?',
    sourceStartMs: 10_000,
    sourceEndMs: 13_000,
    emittedAt: '2026-08-30T00:00:00.000Z',
    final: true,
    sequence: 4,
  },
  {
    id: 'b',
    sessionId: 'session',
    channelId: 'channel-en',
    language: 'en',
    text: 'Consider each question.',
    sourceStartMs: 13_000,
    sourceEndMs: 17_000,
    emittedAt: '2026-08-30T00:00:01.000Z',
    final: true,
    sequence: 5,
  },
];

const latency = transcript.map((segment, index): PipelineLatencySample => ({
  id: `latency-${index}`,
  sessionId: 'session',
  channelId: 'channel-en',
  language: 'en',
  sequence: segment.sequence,
  sourceStartMs: segment.sourceStartMs,
  sourceEndMs: segment.sourceEndMs,
  recordedAt: '2026-08-30T00:00:00.000Z',
  playout: {
    startedAtUnixMs: 1_000 + index * 2_000,
    completedAtUnixMs: 3_000 + index * 3_000,
  },
  metrics: { chunkWindowMs: 3_000 },
  engines: { relay: 'test' },
  outcome: 'complete',
}));

describe('archive review alignment', () => {
  it('builds translated review time from retained rendered-audio durations', () => {
    const track = buildReviewTrack('en', 'channel-en', 'blob:test', transcript, latency, 'ru');
    expect(track.segments.map((segment) => [segment.audioStartMs, segment.audioEndMs])).toEqual([
      [0, 2_000],
      [2_000, 5_000],
    ]);
    expect(track.durationMs).toBe(5_000);
  });

  it('maps a semantic source position while toggling languages', () => {
    const english = buildReviewTrack('en', 'channel-en', 'blob:en', transcript, latency, 'ru');
    const russian = buildReviewTrack(
      'ru',
      'channel-ru',
      'blob:ru',
      transcript.map((segment) => ({ ...segment, channelId: 'channel-ru', language: 'ru' })),
      [],
      'ru',
    );
    const sourceMs = sourceTimeAtAudio(english, 1_000);
    expect(sourceMs).toBe(11_500);
    expect(audioTimeAtSource(russian, sourceMs)).toBe(11_500);
  });

  it('seeks and highlights approximate word positions inside rendered speech', () => {
    const track = buildReviewTrack('en', 'channel-en', 'blob:test', transcript, latency, 'ru');
    expect(wordAudioTime(track.segments[0]!, 2, 3)).toBeCloseTo(1_333.33, 1);
    expect(activeWordIndex(track.segments[0]!, 1_500, 3)).toBe(2);
  });

  it('prefers measured word timestamps when an archive provides them', () => {
    const track = buildReviewTrack(
      'ru',
      'channel-ru',
      'blob:ru',
      [
        {
          ...transcript[0]!,
          channelId: 'channel-ru',
          language: 'ru',
          text: 'Что мы понимаем',
          wordTimings: [
            { text: 'Что', audioStartMs: 10_220, audioEndMs: 10_510 },
            { text: 'мы', audioStartMs: 10_880, audioEndMs: 11_020 },
            { text: 'понимаем', audioStartMs: 11_610, audioEndMs: 12_340 },
          ],
        },
      ],
      [],
      'ru',
    );

    expect(wordAudioTime(track.segments[0]!, 2, 3)).toBe(11_610);
    expect(activeWordIndex(track.segments[0]!, 11_800, 3)).toBe(2);
  });

  it('parses retained JSONL with blank lines', () => {
    expect(parseJsonLines<{ value: number }>('{"value":1}\n\n{"value":2}\n')).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
  });
});
