import { describe, expect, it } from 'vitest';
import type { PipelineLatencySample } from '@multilinguum/protocol';
import { buildLatencyBreakdown, summarizeLatency } from './latency.js';

function sample(index: number): PipelineLatencySample {
  return {
    id: `sample-${index}`,
    sessionId: 'session',
    channelId: 'channel-en',
    language: 'en',
    sequence: index,
    sourceStartMs: index * 5_000,
    sourceEndMs: (index + 1) * 5_000,
    recordedAt: new Date(0).toISOString(),
    metrics: {
      chunkWindowMs: 5_000,
      transcriptionMs: index * 10,
      translationMs: index * 20,
      sourceEndToAudioMs: index * 30,
    },
    engines: { relay: 'test' },
    outcome: 'complete',
  };
}

describe('latency summary', () => {
  it('measures first queued audio as the listener-start latency', () => {
    const metrics = buildLatencyBreakdown({
      id: 'sample',
      sessionId: 'session',
      channelId: 'channel-en',
      language: 'en',
      sequence: 0,
      sourceStartMs: 0,
      sourceEndMs: 2_000,
      recordedAt: new Date(0).toISOString(),
      captureCompletedAtUnixMs: 10_000,
      audioPublish: { startedAtUnixMs: 12_500, completedAtUnixMs: 12_900 },
      engines: { relay: 'test' },
      outcome: 'complete',
    });

    expect(metrics.sourceEndToAudioMs).toBe(2_500);
    expect(metrics.sourceStartToAudioMs).toBe(4_500);
    expect(metrics.audioPublishMs).toBe(400);
  });

  it('uses nearest-rank p50 and p95 without mixing unavailable stages', () => {
    const summary = summarizeLatency(Array.from({ length: 20 }, (_, index) => sample(index + 1)));

    expect(summary.sampleCount).toBe(20);
    expect(summary.latest.translationMs).toBe(400);
    expect(summary.p50.transcriptionMs).toBe(100);
    expect(summary.p95.translationMs).toBe(380);
    expect(summary.p95.sourceEndToAudioMs).toBe(570);
    expect(summary.p95.speechRenderMs).toBeUndefined();
  });
});
