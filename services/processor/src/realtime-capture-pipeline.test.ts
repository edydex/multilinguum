import { describe, expect, it } from 'vitest';
import type {
  AudioChunk,
  ChannelConfig,
  RealtimeTranscriptDelta,
  RealtimeTranslationChannel,
  RenderedSpeech,
  ServiceSession,
  TranscriptSegment,
  Transcriber,
} from '@multilinguum/protocol';
import { RealtimeCapturePipeline } from './realtime-capture-pipeline.js';
import type { SessionEngine } from './session-engine.js';

class FakeTranscriber implements Transcriber {
  readonly name = 'fake-live-transcriber';
  readonly pushed: AudioChunk[] = [];
  readonly #listeners = new Set<(segment: TranscriptSegment) => void>();
  started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    this.pushed.push(chunk);
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  onSegment(listener: (segment: TranscriptSegment) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onError(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  emit(segment: TranscriptSegment): void {
    for (const listener of this.#listeners) listener(segment);
  }
}

class FakeTranslationChannel implements RealtimeTranslationChannel {
  readonly name = 'fake-realtime-translation';
  readonly pushed: AudioChunk[] = [];
  readonly #transcriptListeners = new Set<(delta: RealtimeTranscriptDelta) => void>();
  readonly #audioListeners = new Set<(audio: RenderedSpeech) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  config?: ChannelConfig;

  async start(_session: ServiceSession, channel: ChannelConfig): Promise<void> {
    this.config = channel;
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    this.pushed.push(chunk);
  }

  async stop(): Promise<void> {}

  onTranscriptDelta(listener: (delta: RealtimeTranscriptDelta) => void): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  onAudio(listener: (audio: RenderedSpeech) => void): () => void {
    this.#audioListeners.add(listener);
    return () => this.#audioListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  emitTranscript(delta: RealtimeTranscriptDelta): void {
    for (const listener of this.#transcriptListeners) listener(delta);
  }

  emitAudio(audio: RenderedSpeech): void {
    for (const listener of this.#audioListeners) listener(audio);
  }
}

function liveSession(): ServiceSession {
  const targets: ChannelConfig[] = [
    {
      id: 'channel-ru',
      targetLanguage: 'ru',
      translationProvider: 'openai-realtime',
      voiceMode: 'source',
      fallbackOrder: ['mute'],
      muted: false,
    },
    {
      id: 'channel-en',
      targetLanguage: 'en',
      translationProvider: 'openai-realtime',
      voiceMode: 'natural',
      fallbackOrder: ['mute'],
      muted: false,
    },
  ];
  return {
    id: 'session-live-test',
    state: 'live',
    sourceLanguage: 'ru',
    targets,
    processingNode: {
      id: 'processor-test',
      name: 'Processor',
      mode: 'remote',
      endpoint: 'https://processor.example.test',
      identityFingerprint: '0123456789abcdef',
    },
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    relayRoom: 'service-live-test',
    archivePolicy: {
      retentionDays: 30,
      retainIndefinitely: false,
      recordSource: true,
      recordTranslations: true,
    },
    configurationLocked: true,
    budgetWarningUsd: 20,
    estimatedCostUsd: 1,
  };
}

describe('RealtimeCapturePipeline', () => {
  it('fans capture to one shared transcriber and direct target, then normalizes outputs', async () => {
    const sourceAudio: unknown[] = [];
    const sourceTranscripts: unknown[] = [];
    const translatedTranscripts: unknown[] = [];
    const translatedAudio: unknown[] = [];
    const engine = {
      ingestSourceAudio: async (input: unknown) => sourceAudio.push(input),
      ingestLiveTranscript: async (...input: unknown[]) => {
        sourceTranscripts.push(input);
        return [];
      },
      ingestRealtimeTranscript: async (...input: unknown[]) => {
        translatedTranscripts.push(input);
        return {};
      },
      ingestRealtimeAudio: async (...input: unknown[]) => translatedAudio.push(input),
      reportChannelFailure: () => undefined,
    } as unknown as SessionEngine;
    const transcriber = new FakeTranscriber();
    const translation = new FakeTranslationChannel();
    const session = liveSession();
    const pipeline = new RealtimeCapturePipeline(engine, session, transcriber, () => translation);

    await pipeline.start();
    pipeline.push(new Uint8Array(48_000 * 5 * 2), Date.now());
    transcriber.emit({
      id: 'source-1',
      sessionId: session.id,
      channelId: 'source-ru',
      language: 'ru',
      text: 'Благодать вам и мир.',
      sourceStartMs: 200,
      sourceEndMs: 1_600,
      emittedAt: new Date().toISOString(),
      final: true,
      sequence: 0,
    });
    translation.emitTranscript({
      sessionId: session.id,
      channelId: 'channel-en',
      language: 'en',
      delta: 'Grace to ',
      sourceElapsedMs: 1_200,
      receivedAtUnixMs: Date.now(),
    });
    translation.emitTranscript({
      sessionId: session.id,
      channelId: 'channel-en',
      language: 'en',
      delta: 'you and peace.',
      sourceElapsedMs: 1_600,
      receivedAtUnixMs: Date.now(),
    });
    translation.emitAudio({
      data: new Uint8Array(960),
      encoding: 'pcm_s16le',
      sampleRate: 48_000,
      startMs: 1_200,
      endMs: 1_210,
      sequence: 0,
      language: 'en',
      renderer: translation.name,
    });
    await pipeline.close();

    expect(transcriber.pushed).toHaveLength(1);
    expect(translation.pushed).toHaveLength(1);
    expect(sourceAudio).toHaveLength(1);
    expect(sourceTranscripts).toHaveLength(1);
    expect(translatedTranscripts).toEqual([
      [
        'channel-en',
        expect.objectContaining({
          text: 'Grace to you and peace.',
          sourceStartMs: 1_200,
          sourceEndMs: 1_600,
          sequence: 0,
        }),
      ],
    ]);
    expect(translatedAudio).toHaveLength(1);
  });
});
