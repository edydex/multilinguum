import type {
  AudioChunk,
  RealtimeTranscriptDelta,
  RealtimeTranslationChannel,
  RenderedSpeech,
  ServiceSession,
  TranscriptSegment,
  Transcriber,
} from '@multilinguum/protocol';
import type { SessionEngine } from './session-engine.js';

const samplesPerSourceArchiveChunk = 48_000 * 5;
const bytesPerSample = 2;

interface TranscriptBuffer {
  text: string;
  startMs: number;
  endMs: number;
  firstDeltaAtUnixMs: number;
  sequence: number;
}

interface CapturePoint {
  endMs: number;
  capturedAtUnixMs: number;
}

interface CascadeBuffer {
  segment: TranscriptSegment;
  timing: Parameters<SessionEngine['ingestLiveTranscript']>[1];
}

const expressiveMaximumWindowMs = 8_000;

function lastSentenceBoundary(text: string): number {
  const pattern = /[.!?…]["'»”)]*(?=\s|$)/gu;
  let boundary = 0;
  for (const match of text.matchAll(pattern)) {
    boundary = (match.index ?? 0) + match[0].length;
  }
  return boundary;
}

export type RealtimeTranslationChannelFactory = () => RealtimeTranslationChannel;

export class RealtimeCapturePipeline {
  readonly #engine: SessionEngine;
  readonly #session: ServiceSession;
  readonly #transcriber: Transcriber;
  readonly #channelFactory: RealtimeTranslationChannelFactory;
  readonly #channels = new Map<string, RealtimeTranslationChannel>();
  readonly #activeDirectChannelIds = new Set<string>();
  readonly #transcriptBuffers = new Map<string, TranscriptBuffer>();
  readonly #transcriptSequences = new Map<string, number>();
  readonly #audioChains = new Map<string, Promise<void>>();
  readonly #captureTimeline: CapturePoint[] = [];
  readonly #unsubscribers: Array<() => void> = [];
  #pendingSource = new Uint8Array();
  #processedSamples = 0;
  #frameSequence = 0;
  #sourceSequence = 0;
  #latestCapturedAtUnixMs = 0;
  #cascadeBuffer: CascadeBuffer | undefined;
  #cascadeSequence = 0;
  #inputChain = Promise.resolve();
  #sourceTranscriptChain = Promise.resolve();
  #cascadeTranscriptChain = Promise.resolve();
  #translatedTranscriptChain = Promise.resolve();
  #started = false;

  constructor(
    engine: SessionEngine,
    session: ServiceSession,
    transcriber: Transcriber,
    channelFactory: RealtimeTranslationChannelFactory,
  ) {
    this.#engine = engine;
    this.#session = session;
    this.#transcriber = transcriber;
    this.#channelFactory = channelFactory;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('Realtime capture pipeline is already started.');
    this.#started = true;
    this.#unsubscribers.push(
      this.#transcriber.onSegment((segment) => this.#receiveSourceTranscript(segment)),
      this.#transcriber.onError((error) =>
        this.#engine.reportChannelFailure(this.#sourceChannelId(), error),
      ),
    );
    await this.#transcriber.start(this.#session);
    const directConfigs = this.#session.targets.filter(
      (channel) =>
        !channel.muted &&
        channel.voiceMode === 'natural' &&
        channel.translationProvider === 'openai-realtime',
    );
    try {
      await Promise.all(
        directConfigs.map(async (config) => {
          const channel = this.#channelFactory();
          this.#channels.set(config.id, channel);
          this.#unsubscribers.push(
            channel.onTranscriptDelta((delta) => this.#receiveTranslatedDelta(delta)),
            channel.onAudio((audio) => this.#receiveTranslatedAudio(config.id, audio)),
            channel.onError((error) => this.#failDirectChannel(config.id, error)),
          );
          await channel.start(this.#session, config);
          this.#activeDirectChannelIds.add(config.id);
        }),
      );
    } catch (error) {
      await Promise.allSettled([...this.#channels.values()].map((channel) => channel.stop()));
      await this.#transcriber.stop();
      throw error;
    }
  }

  push(frame: Uint8Array, capturedAtUnixMs = Date.now()): void {
    if (!this.#started) throw new Error('Realtime capture pipeline is not started.');
    if (frame.byteLength % bytesPerSample !== 0) {
      throw new Error('PCM frame is not 16-bit aligned.');
    }
    const samples = frame.byteLength / bytesPerSample;
    const startMs = Math.round((this.#processedSamples / 48_000) * 1_000);
    this.#processedSamples += samples;
    const endMs = Math.round((this.#processedSamples / 48_000) * 1_000);
    const chunk: AudioChunk = {
      data: frame,
      encoding: 'pcm_s16le',
      sampleRate: 48_000,
      startMs,
      endMs,
      sequence: this.#frameSequence++,
    };
    this.#captureTimeline.push({ endMs, capturedAtUnixMs });
    while (this.#captureTimeline.length > 1 && this.#captureTimeline[0]!.endMs < endMs - 120_000) {
      this.#captureTimeline.shift();
    }
    this.#latestCapturedAtUnixMs = capturedAtUnixMs;
    this.#inputChain = this.#inputChain
      .then(async () => {
        this.#appendPendingSource(frame);
        await Promise.all([
          this.#transcriber.pushAudio(chunk),
          ...[...this.#channels.entries()]
            .filter(([channelId]) => this.#activeDirectChannelIds.has(channelId))
            .map(([, channel]) => channel.pushAudio(chunk)),
        ]);
        await this.#flushCompleteSourceChunks(capturedAtUnixMs);
      })
      .catch((error) => {
        this.#engine.reportChannelFailure(
          this.#sourceChannelId(),
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    await this.#inputChain;
    await this.#flushPendingSource();
    await Promise.allSettled([...this.#channels.values()].map((channel) => channel.stop()));
    await this.#transcriber.stop();
    for (const channelId of this.#transcriptBuffers.keys()) this.#flushTranscript(channelId);
    this.#flushCompletedCascadeAtStop();
    await Promise.all([
      this.#sourceTranscriptChain,
      this.#cascadeTranscriptChain,
      this.#translatedTranscriptChain,
      ...this.#audioChains.values(),
    ]);
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#channels.clear();
    this.#activeDirectChannelIds.clear();
  }

  #appendPendingSource(frame: Uint8Array): void {
    const combined = new Uint8Array(this.#pendingSource.byteLength + frame.byteLength);
    combined.set(this.#pendingSource);
    combined.set(frame, this.#pendingSource.byteLength);
    this.#pendingSource = combined;
  }

  async #flushCompleteSourceChunks(capturedAtUnixMs: number): Promise<void> {
    const chunkBytes = samplesPerSourceArchiveChunk * bytesPerSample;
    while (this.#pendingSource.byteLength >= chunkBytes) {
      const data = this.#pendingSource.slice(0, chunkBytes);
      this.#pendingSource = this.#pendingSource.slice(chunkBytes);
      await this.#publishSourceChunk(data, capturedAtUnixMs);
    }
  }

  async #flushPendingSource(): Promise<void> {
    if (this.#pendingSource.byteLength < 48_000 * bytesPerSample) return;
    const data = this.#pendingSource;
    this.#pendingSource = new Uint8Array();
    await this.#publishSourceChunk(data, this.#latestCapturedAtUnixMs || Date.now());
  }

  async #publishSourceChunk(data: Uint8Array, capturedAtUnixMs: number): Promise<void> {
    const samples = data.byteLength / bytesPerSample;
    const endMs = Math.round(
      ((this.#sourceSequence * samplesPerSourceArchiveChunk + samples) / 48_000) * 1_000,
    );
    const startMs = Math.max(0, endMs - Math.round((samples / 48_000) * 1_000));
    await this.#engine.ingestSourceAudio({
      data,
      startMs,
      endMs,
      sequence: this.#sourceSequence++,
      language: this.#session.sourceLanguage,
      timing: { captureCompletedAtUnixMs: capturedAtUnixMs, chunkReadyAtUnixMs: Date.now() },
    });
  }

  #receiveSourceTranscript(segment: TranscriptSegment): void {
    const completedAtUnixMs = Date.parse(segment.emittedAt);
    const captureCompletedAtUnixMs = this.#captureTimestamp(segment.sourceEndMs);
    const timing = {
      ...(captureCompletedAtUnixMs !== undefined
        ? {
            captureCompletedAtUnixMs,
            chunkReadyAtUnixMs: captureCompletedAtUnixMs,
          }
        : {}),
      transcriptionEngine: this.#transcriber.name,
      transcription: {
        startedAtUnixMs:
          captureCompletedAtUnixMs ??
          Date.parse(this.#session.startedAt ?? this.#session.createdAt) + segment.sourceEndMs,
        ...(segment.firstDeltaAtUnixMs !== undefined
          ? { firstDeltaAtUnixMs: segment.firstDeltaAtUnixMs }
          : {}),
        completedAtUnixMs: Number.isFinite(completedAtUnixMs) ? completedAtUnixMs : Date.now(),
      },
    };
    const sourceChannelIds = new Set([this.#sourceChannelId()]);
    this.#sourceTranscriptChain = this.#sourceTranscriptChain
      .then(async () => {
        await this.#engine.ingestLiveTranscript(
          segment,
          timing,
          this.#activeDirectChannelIds,
          sourceChannelIds,
        );
      })
      .catch((error) => {
        this.#engine.reportChannelFailure(
          this.#sourceChannelId(),
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    this.#bufferCascadeTranscript(segment, timing);
  }

  #bufferCascadeTranscript(
    segment: TranscriptSegment,
    timing: Parameters<SessionEngine['ingestLiveTranscript']>[1],
  ): void {
    const hasCascadeChannel = this.#session.targets.some(
      (channel) => channel.voiceMode !== 'source' && !this.#activeDirectChannelIds.has(channel.id),
    );
    if (!hasCascadeChannel) return;
    const existing = this.#cascadeBuffer?.segment;
    this.#cascadeBuffer = {
      segment: existing
        ? {
            ...existing,
            text: `${existing.text.trim()} ${segment.text.trim()}`,
            sourceEndMs: Math.max(existing.sourceEndMs, segment.sourceEndMs),
            emittedAt: segment.emittedAt,
            final: true,
          }
        : {
            ...segment,
            sequence: this.#cascadeSequence,
          },
      timing,
    };
    const buffered = this.#cascadeBuffer.segment;
    const boundary = lastSentenceBoundary(buffered.text);
    if (boundary > 0) {
      this.#flushCascadeSentence(boundary);
    } else if (buffered.sourceEndMs - buffered.sourceStartMs >= expressiveMaximumWindowMs) {
      this.#flushCascadeTranscript();
    }
  }

  #flushCascadeSentence(boundary: number): void {
    const buffered = this.#cascadeBuffer;
    if (!buffered) return;
    const completeText = buffered.segment.text.slice(0, boundary).trim();
    const remainingText = buffered.segment.text.slice(boundary).trim();
    if (!completeText) return;
    const durationMs = buffered.segment.sourceEndMs - buffered.segment.sourceStartMs;
    const completeRatio = Math.min(1, boundary / Math.max(1, buffered.segment.text.length));
    const completeEndMs = Math.max(
      buffered.segment.sourceStartMs + 1,
      Math.round(buffered.segment.sourceStartMs + durationMs * completeRatio),
    );
    const trailingMs = Math.max(0, buffered.segment.sourceEndMs - completeEndMs);
    const captureCompletedAtUnixMs = buffered.timing?.captureCompletedAtUnixMs;
    const completeTiming = buffered.timing
      ? {
          ...buffered.timing,
          ...(captureCompletedAtUnixMs !== undefined
            ? { captureCompletedAtUnixMs: captureCompletedAtUnixMs - trailingMs }
            : {}),
        }
      : undefined;
    this.#cascadeBuffer = {
      segment: {
        ...buffered.segment,
        text: completeText,
        sourceEndMs: completeEndMs,
      },
      timing: completeTiming,
    };
    this.#flushCascadeTranscript();
    if (remainingText) {
      this.#cascadeBuffer = {
        segment: {
          ...buffered.segment,
          id: `${buffered.segment.id}-continuation`,
          text: remainingText,
          sourceStartMs: completeEndMs,
          sequence: this.#cascadeSequence,
        },
        timing: buffered.timing,
      };
    }
  }

  #flushCascadeTranscript(): void {
    const buffered = this.#cascadeBuffer;
    if (!buffered) return;
    this.#cascadeBuffer = undefined;
    this.#cascadeSequence += 1;
    const cascadeChannelIds = new Set(
      this.#session.targets
        .filter(
          (channel) =>
            channel.voiceMode !== 'source' && !this.#activeDirectChannelIds.has(channel.id),
        )
        .map((channel) => channel.id),
    );
    if (cascadeChannelIds.size === 0) return;
    this.#cascadeTranscriptChain = this.#cascadeTranscriptChain
      .then(async () => {
        await this.#engine.ingestLiveTranscript(
          buffered.segment,
          buffered.timing,
          this.#activeDirectChannelIds,
          cascadeChannelIds,
        );
      })
      .catch((error) => {
        for (const channelId of cascadeChannelIds) {
          this.#engine.reportChannelFailure(
            channelId,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
  }

  #flushCompletedCascadeAtStop(): void {
    const buffered = this.#cascadeBuffer;
    if (!buffered) return;
    const boundary = lastSentenceBoundary(buffered.segment.text);
    if (boundary > 0) this.#flushCascadeSentence(boundary);
    // A short unpunctuated tail is intentionally not translated at Stop. It is
    // usually a sentence cut off by the operator, and context notes must never
    // be allowed to supply words that were not captured.
    this.#cascadeBuffer = undefined;
  }

  #captureTimestamp(sourceEndMs: number): number | undefined {
    const point = this.#captureTimeline.find((candidate) => candidate.endMs >= sourceEndMs);
    if (!point) return undefined;
    return Math.round(point.capturedAtUnixMs - Math.max(0, point.endMs - sourceEndMs));
  }

  #receiveTranslatedDelta(delta: RealtimeTranscriptDelta): void {
    if (!this.#activeDirectChannelIds.has(delta.channelId)) return;
    const elapsed = Math.max(0, Math.round(delta.sourceElapsedMs ?? 0));
    const existing = this.#transcriptBuffers.get(delta.channelId);
    const buffer: TranscriptBuffer = existing ?? {
      text: '',
      startMs: elapsed,
      endMs: elapsed,
      firstDeltaAtUnixMs: delta.receivedAtUnixMs,
      sequence: this.#transcriptSequences.get(delta.channelId) ?? 0,
    };
    buffer.text += delta.delta;
    buffer.endMs = Math.max(buffer.endMs, elapsed);
    this.#transcriptBuffers.set(delta.channelId, buffer);
    const clauseEnded = /[.!?…]["'»”)]*\s*$/u.test(buffer.text);
    if (clauseEnded || buffer.text.length >= 240 || buffer.endMs - buffer.startMs >= 3_000) {
      this.#flushTranscript(delta.channelId);
    }
  }

  #flushTranscript(channelId: string): void {
    const buffer = this.#transcriptBuffers.get(channelId);
    const text = buffer?.text.trim();
    if (!buffer || !text) return;
    this.#transcriptBuffers.delete(channelId);
    this.#transcriptSequences.set(channelId, buffer.sequence + 1);
    this.#translatedTranscriptChain = this.#translatedTranscriptChain
      .then(async () => {
        await this.#engine.ingestRealtimeTranscript(channelId, {
          text,
          sourceStartMs: buffer.startMs,
          sourceEndMs: Math.max(buffer.startMs + 1, buffer.endMs),
          sequence: buffer.sequence,
          firstDeltaAtUnixMs: buffer.firstDeltaAtUnixMs,
        });
      })
      .catch((error) =>
        this.#failDirectChannel(
          channelId,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
  }

  #receiveTranslatedAudio(channelId: string, audio: RenderedSpeech): void {
    if (!this.#activeDirectChannelIds.has(channelId)) return;
    const chain = (this.#audioChains.get(channelId) ?? Promise.resolve())
      .then(() => this.#engine.ingestRealtimeAudio(channelId, audio))
      .catch((error) =>
        this.#failDirectChannel(
          channelId,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    this.#audioChains.set(channelId, chain);
  }

  #failDirectChannel(channelId: string, error: Error): void {
    if (!this.#activeDirectChannelIds.delete(channelId)) return;
    this.#engine.reportChannelFailure(channelId, error, 'openai-cascade+natural-fallback');
  }

  #sourceChannelId(): string {
    const source = this.#session.targets.find((channel) => channel.voiceMode === 'source');
    if (!source) throw new Error('Session has no source-language channel.');
    return source.id;
  }
}
