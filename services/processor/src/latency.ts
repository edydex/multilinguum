import type {
  ChannelLatencySummary,
  PipelineLatencyBreakdown,
  PipelineLatencySample,
} from '@multilinguum/protocol';

const metricNames = [
  'chunkWindowMs',
  'chunkReadyDelayMs',
  'captureToTranscriptionStartMs',
  'transcriptionFirstDeltaMs',
  'transcriptionMs',
  'translationFirstDeltaMs',
  'translationMs',
  'speechRenderMs',
  'captionPublishMs',
  'audioPublishMs',
  'sourceEndToTranscriptMs',
  'sourceEndToCaptionMs',
  'sourceEndToAudioMs',
  'sourceStartToAudioMs',
] as const satisfies ReadonlyArray<keyof PipelineLatencyBreakdown>;

function elapsed(startedAtUnixMs: number, completedAtUnixMs: number): number {
  return Math.max(0, Math.round(completedAtUnixMs - startedAtUnixMs));
}

export function buildLatencyBreakdown(
  sample: Omit<PipelineLatencySample, 'metrics'>,
): PipelineLatencyBreakdown {
  const metrics: PipelineLatencyBreakdown = {
    chunkWindowMs: Math.max(0, sample.sourceEndMs - sample.sourceStartMs),
  };
  if (sample.captureCompletedAtUnixMs !== undefined) {
    if (sample.chunkReadyAtUnixMs !== undefined) {
      metrics.chunkReadyDelayMs = Math.round(
        sample.chunkReadyAtUnixMs - sample.captureCompletedAtUnixMs,
      );
    }
    if (sample.transcription) {
      metrics.captureToTranscriptionStartMs = Math.round(
        sample.transcription.startedAtUnixMs - sample.captureCompletedAtUnixMs,
      );
      metrics.sourceEndToTranscriptMs = Math.round(
        sample.transcription.completedAtUnixMs - sample.captureCompletedAtUnixMs,
      );
    }
    if (sample.captionPublish) {
      metrics.sourceEndToCaptionMs = Math.round(
        sample.captionPublish.completedAtUnixMs - sample.captureCompletedAtUnixMs,
      );
    }
    if (sample.audioPublish) {
      metrics.sourceEndToAudioMs = Math.round(
        sample.audioPublish.startedAtUnixMs - sample.captureCompletedAtUnixMs,
      );
      metrics.sourceStartToAudioMs = metrics.sourceEndToAudioMs + metrics.chunkWindowMs;
    }
  }
  if (sample.transcription) {
    metrics.transcriptionMs = elapsed(
      sample.transcription.startedAtUnixMs,
      sample.transcription.completedAtUnixMs,
    );
    if (sample.transcription.firstDeltaAtUnixMs !== undefined) {
      metrics.transcriptionFirstDeltaMs = elapsed(
        sample.transcription.startedAtUnixMs,
        sample.transcription.firstDeltaAtUnixMs,
      );
    }
  }
  if (sample.translation) {
    metrics.translationMs = elapsed(
      sample.translation.startedAtUnixMs,
      sample.translation.completedAtUnixMs,
    );
    if (sample.translation.firstDeltaAtUnixMs !== undefined) {
      metrics.translationFirstDeltaMs = elapsed(
        sample.translation.startedAtUnixMs,
        sample.translation.firstDeltaAtUnixMs,
      );
    }
  }
  if (sample.speechRender) {
    metrics.speechRenderMs = elapsed(
      sample.speechRender.startedAtUnixMs,
      sample.speechRender.completedAtUnixMs,
    );
  }
  if (sample.captionPublish) {
    metrics.captionPublishMs = elapsed(
      sample.captionPublish.startedAtUnixMs,
      sample.captionPublish.completedAtUnixMs,
    );
  }
  if (sample.audioPublish) {
    metrics.audioPublishMs = elapsed(
      sample.audioPublish.startedAtUnixMs,
      sample.audioPublish.completedAtUnixMs,
    );
  }
  return metrics;
}

function percentile(values: number[], quantile: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function aggregate(samples: PipelineLatencySample[], quantile: number): PipelineLatencyBreakdown {
  const output = {} as PipelineLatencyBreakdown;
  for (const name of metricNames) {
    const values = samples
      .map((sample) => sample.metrics[name])
      .filter((value): value is number => value !== undefined);
    const value = percentile(values, quantile);
    if (value !== undefined) output[name] = value;
  }
  output.chunkWindowMs ??= 0;
  return output;
}

export function summarizeLatency(samples: PipelineLatencySample[]): ChannelLatencySummary {
  if (samples.length === 0) {
    throw new Error('Cannot summarize an empty latency sample set.');
  }
  return {
    sampleCount: samples.length,
    latest: samples.at(-1)!.metrics,
    p50: aggregate(samples, 0.5),
    p95: aggregate(samples, 0.95),
  };
}
