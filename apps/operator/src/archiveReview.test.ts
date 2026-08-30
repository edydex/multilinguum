import { describe, expect, it } from 'vitest';
import type { PipelineLatencySample, TranscriptSegment } from '@multilinguum/protocol';
import {
  activeWordIndex,
  audioTimeAtSource,
  buildDefaultThoughtAnchors,
  buildReviewTrack,
  parseJsonLines,
  sourceTimeAtAudio,
  thoughtAlignedAudioTime,
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

  it('switches at the beginning of the matching thought instead of matching elapsed seconds', () => {
    const english = buildReviewTrack('en', 'channel-en', 'blob:en', transcript, latency, 'ru');
    const russian = buildReviewTrack(
      'ru',
      'channel-ru',
      'blob:ru',
      transcript.map((segment) => ({ ...segment, channelId: 'channel-ru', language: 'ru' })),
      [],
      'ru',
    );
    const anchors = [
      {
        id: 'three-questions',
        label: 'The three questions',
        sourceStartMs: 10_000,
        sourceEndMs: 17_000,
      },
    ];

    expect(thoughtAlignedAudioTime(english, russian, 3_500, anchors)).toMatchObject({
      audioMs: 10_000,
      sourceMs: 10_000,
      anchor: anchors[0],
    });
  });

  it('groups unfinished streaming fragments into reusable default thought anchors', () => {
    const track = buildReviewTrack(
      'en',
      'channel-en',
      'blob:en',
      [
        { ...transcript[0]!, text: 'This thought continues...' },
        { ...transcript[1]!, text: 'and now it resolves.' },
      ],
      latency,
      'ru',
    );

    expect(buildDefaultThoughtAnchors(track.segments)).toEqual([
      expect.objectContaining({
        id: 'thought-4-5',
        sourceStartMs: 10_000,
        sourceEndMs: 17_000,
      }),
    ]);
  });

  it('seeks and highlights approximate word positions inside rendered speech', () => {
    const track = buildReviewTrack('en', 'channel-en', 'blob:test', transcript, latency, 'ru');
    expect(wordAudioTime(track.segments[0]!, 2, 3)).toBeCloseTo(1_333.33, 1);
    expect(activeWordIndex(track.segments[0]!, 1_500, 3)).toBe(2);
  });

  it('parses retained JSONL with blank lines', () => {
    expect(parseJsonLines<{ value: number }>('{"value":1}\n\n{"value":2}\n')).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
  });
});
