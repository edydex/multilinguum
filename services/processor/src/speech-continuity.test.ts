import { describe, expect, it } from 'vitest';
import type { RenderedSpeech } from '@multilinguum/protocol';
import { naturalSpeechSpeed } from './providers/openai-cascade.js';
import {
  buildCaptionWordTimings,
  prepareSpeechForContinuousPlayout,
  speechDurationMs,
  targetLeadingPauseMs,
  targetTrailingPauseMs,
} from './speech-continuity.js';

function speech(samples: Int16Array): RenderedSpeech {
  return {
    data: new Uint8Array(samples.buffer),
    encoding: 'pcm_s16le',
    sampleRate: 48_000,
    startMs: 0,
    endMs: 1_000,
    sequence: 0,
    language: 'en',
    renderer: 'test',
  };
}

describe('continuous speech preparation', () => {
  it('removes long synthetic padding but retains natural room around speech', () => {
    const samples = new Int16Array(48_000 * 5);
    for (let index = 48_000 * 2; index < 48_000 * 3; index += 1) {
      samples[index] = index % 2 === 0 ? 4_000 : -4_000;
    }

    const prepared = prepareSpeechForContinuousPlayout(speech(samples));

    expect(speechDurationMs(prepared)).toBeGreaterThanOrEqual(1_130);
    expect(speechDurationMs(prepared)).toBeLessThanOrEqual(1_160);
  });

  it('does not accelerate routine queues and applies only gentle emergency catch-up', () => {
    expect(naturalSpeechSpeed(0)).toBe(0.96);
    expect(naturalSpeechSpeed(19_999)).toBe(0.96);
    expect(naturalSpeechSpeed(20_000)).toBe(1.03);
    expect(naturalSpeechSpeed(32_000)).toBe(1.07);
    expect(naturalSpeechSpeed(60_000)).toBe(1.12);
  });

  it('retains a bounded source pause and aligns every caption word to measured speech', () => {
    const samples = new Int16Array(48_000 * 3);
    for (let index = 48_000; index < 48_000 * 2; index += 1) {
      samples[index] = index % 2 === 0 ? 4_000 : -4_000;
    }
    const prepared = prepareSpeechForContinuousPlayout(
      speech(samples),
      targetTrailingPauseMs(undefined, 600),
    );
    expect(speechDurationMs(prepared)).toBeGreaterThanOrEqual(1_480);
    expect(speechDurationMs(prepared)).toBeLessThanOrEqual(1_510);

    const words = buildCaptionWordTimings('Grace to you, and peace.', 1_300);
    expect(words.map((word) => word.text)).toEqual(['Grace', 'to', 'you,', 'and', 'peace.']);
    expect(words[0]?.startOffsetMs).toBe(0);
    expect(words.at(-1)?.endOffsetMs).toBe(1_300);
  });

  it('uses the target-language boundary instead of copying the source pause', () => {
    const connected = targetTrailingPauseMs(
      {
        role: 'contrast',
        cadence: 'flowing',
        arc: 'build',
        pauseBefore: 'none',
        pauseAfter: 'connected',
        emphasis: [],
        beats: [],
      },
      900,
    );
    const resolved = targetTrailingPauseMs(
      {
        role: 'appeal',
        cadence: 'measured',
        arc: 'resolution',
        pauseBefore: 'brief',
        pauseAfter: 'full',
        emphasis: ['implores'],
        beats: [],
      },
      80,
    );

    expect(connected).toBe(80);
    expect(resolved).toBe(300);
    expect(
      targetLeadingPauseMs({
        role: 'appeal',
        cadence: 'measured',
        arc: 'climax',
        pauseBefore: 'brief',
        pauseAfter: 'full',
        emphasis: ['implores'],
        beats: [],
      }),
    ).toBe(140);

    const words = buildCaptionWordTimings('He implores.', 800, 140);
    expect(words[0]?.startOffsetMs).toBe(140);
    expect(words.at(-1)?.endOffsetMs).toBe(940);
  });
});
