import { describe, expect, it } from 'vitest';
import type { RenderedSpeech } from '@multilinguum/protocol';
import { naturalSpeechSpeed } from './providers/openai-cascade.js';
import { prepareSpeechForContinuousPlayout, speechDurationMs } from './speech-continuity.js';

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
    expect(naturalSpeechSpeed(0)).toBe(0.98);
    expect(naturalSpeechSpeed(19_999)).toBe(0.98);
    expect(naturalSpeechSpeed(20_000)).toBe(1.03);
    expect(naturalSpeechSpeed(32_000)).toBe(1.07);
    expect(naturalSpeechSpeed(60_000)).toBe(1.12);
  });
});
