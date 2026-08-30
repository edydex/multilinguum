import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@multilinguum/protocol';
import { captionWordState, mergeCaption } from './caption-timeline';

function segment(input: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'caption',
    sessionId: 'session-1',
    channelId: 'channel-en',
    language: 'en',
    text: 'Grace to you.',
    sourceStartMs: 0,
    sourceEndMs: 1_000,
    emittedAt: new Date().toISOString(),
    final: false,
    sequence: 0,
    ...input,
  };
}

describe('listener caption timeline', () => {
  it('revises provisional text in place, then retains finalized caption history', () => {
    let timeline = mergeCaption(undefined, segment({ text: 'Grace', revision: 1 }));
    timeline = mergeCaption(timeline, segment({ text: 'Grace to you', revision: 2 }));
    expect(timeline.live?.text).toBe('Grace to you');

    timeline = mergeCaption(timeline, segment({ text: 'Grace to you.', revision: 3, final: true }));
    expect(timeline.live).toBeUndefined();
    timeline = mergeCaption(
      timeline,
      segment({ id: 'next', text: 'Peace', sequence: 1, revision: 1 }),
    );

    expect(timeline.final.map((item) => item.text)).toEqual(['Grace to you.']);
    expect(timeline.live?.text).toBe('Peace');
  });

  it('classifies karaoke words against scheduled playout', () => {
    expect(captionWordState(1_000, 1_500, 999)).toBe('future');
    expect(captionWordState(1_000, 1_500, 1_250)).toBe('current');
    expect(captionWordState(1_000, 1_500, 1_500)).toBe('spoken');
  });
});
