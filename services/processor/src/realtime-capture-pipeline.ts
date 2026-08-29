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
  readonly #unsubscribers: Array<() => void> = [];
  #pendingSource = new Uint8Array();
  #processedSamples = 0;
  #frameSequence = 0;
  #sourceSequence = 0;
  #latestCapturedAtUnixMs = 0;
  #inputChain = Promise.resolve();
  #sourceTranscriptChain = Promise.resolve();
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
    for (const channelId of this.#transcriptBuffers.keys()) this.#flushTranscript(channelId);
    await this.#transcriber.stop();
    await Promise.all([
      this.#sourceTranscriptChain,
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
    this.#sourceTranscriptChain = this.#sourceTranscriptChain
      .then(async () => {
        await this.#engine.ingestLiveTranscript(
          segment,
          {
            transcriptionEngine: this.#transcriber.name,
            transcription: {
              startedAtUnixMs:
                Date.parse(this.#session.startedAt ?? this.#session.createdAt) +
                segment.sourceStartMs,
              completedAtUnixMs: Number.isFinite(completedAtUnixMs)
                ? completedAtUnixMs
                : Date.now(),
            },
          },
          this.#activeDirectChannelIds,
        );
      })
      .catch((error) => {
        this.#engine.reportChannelFailure(
          this.#sourceChannelId(),
          error instanceof Error ? error : new Error(String(error)),
        );
      });
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
