import { describe, expect, it } from 'vitest';
import type {
  ArchiveManifest,
  ChannelConfig,
  MediaRelay,
  RenderedSpeech,
  ServiceSession,
  SpeechRenderer,
  TranscriptSegment,
  TranslationProvider,
} from '@multilinguum/protocol';
import { SessionEngine } from './session-engine.js';

function manifest(session: ServiceSession): ArchiveManifest {
  return {
    version: 1,
    sessionId: session.id,
    createdAt: session.createdAt,
    sourceLanguage: session.sourceLanguage,
    engineVersions: {},
    audioTracks: [],
    transcripts: [],
    latencyReport: { path: 'latency.jsonl', sampleCount: 0, channels: {} },
    retentionDeadline: new Date(Date.now() + 86_400_000).toISOString(),
    retained: false,
  };
}

class DeferredSpeech implements SpeechRenderer {
  readonly name = 'deferred-speech';
  readonly pending: Array<{
    segment: TranscriptSegment;
    resolve: (audio: RenderedSpeech) => void;
  }> = [];

  render(segment: TranscriptSegment): Promise<RenderedSpeech> {
    return new Promise((resolve) => this.pending.push({ segment, resolve }));
  }

  resolve(sequence: number): void {
    const pending = this.pending.find((item) => item.segment.sequence === sequence);
    if (!pending) throw new Error(`No pending render for ${sequence}.`);
    pending.resolve({
      data: new Uint8Array(960),
      encoding: 'pcm_s16le',
      sampleRate: 48_000,
      startMs: pending.segment.sourceStartMs,
      endMs: pending.segment.sourceEndMs,
      sequence,
      language: pending.segment.language,
      renderer: this.name,
    });
  }

  async health() {
    return { ready: true };
  }
}

describe('SessionEngine look-ahead speech queue', () => {
  it('renders ahead, publishes in sequence, and promotes live captions to final', async () => {
    const captions: TranscriptSegment[] = [];
    const audio: RenderedSpeech[] = [];
    const transcripts: TranscriptSegment[] = [];
    const renderer = new DeferredSpeech();
    let activeManifest: ArchiveManifest | undefined;
    const relay: MediaRelay = {
      name: 'test-relay',
      onListenerCount: () => () => undefined,
      createSession: async () => undefined,
      publishChannel: async (config: ChannelConfig) => ({
        channelId: config.id,
        roomName: 'test-room',
        trackName: `translation-${config.targetLanguage}`,
      }),
      audioBacklogMs: () => 0,
      publishAudio: async (_channelId, chunk) => {
        audio.push(chunk);
      },
      publishCaption: async (segment) => {
        captions.push(segment);
      },
      closeSession: async () => undefined,
    };
    const translation: TranslationProvider = {
      name: 'test-translation',
      translate: async (segment, context) => ({
        ...segment,
        id: `${segment.id}-${context.targetLanguage}`,
        language: context.targetLanguage,
        text: `Translated ${segment.sequence}`,
      }),
    };
    const engine = new SessionEngine({
      archive: {
        create: async (session) => {
          activeManifest = manifest(session);
          return activeManifest;
        },
        appendTranscript: async (segment) => {
          transcripts.push(segment);
        },
        appendAudio: async () => undefined,
        appendLatency: async () => undefined,
        finalize: async () => activeManifest!,
        list: async () => [],
        retain: async () => activeManifest!,
        delete: async () => undefined,
        purgeExpired: async () => [],
      },
      relay,
      profiles: {} as never,
      context: {
        require: async () => undefined,
        retrieve: async () => [],
      } as never,
      deterministicTranslation: translation,
      cloudTranslation: translation,
      deterministicSpeech: renderer,
      naturalSpeech: renderer,
      broadcast: () => undefined,
    });
    const targets: ChannelConfig[] = [
      {
        id: 'channel-ru',
        targetLanguage: 'ru',
        translationProvider: 'openai-cascade',
        voiceMode: 'source',
        fallbackOrder: ['mute'],
        muted: false,
      },
      {
        id: 'channel-en',
        targetLanguage: 'en',
        translationProvider: 'openai-cascade',
        voiceMode: 'natural',
        fallbackOrder: ['mute'],
        muted: false,
      },
    ];
    await engine.create({
      sourceLanguage: 'ru',
      targets,
      processingNode: {
        id: 'node',
        name: 'Node',
        mode: 'remote',
        endpoint: 'https://processor.example.test',
        identityFingerprint: '0123456789abcdef',
      },
      archivePolicy: {
        retentionDays: 30,
        retainIndefinitely: false,
        recordSource: true,
        recordTranslations: true,
      },
      contextDocumentIds: [],
      expectedDurationMinutes: 1,
      budgetWarningUsd: 20,
    });
    await engine.start();

    await engine.ingestProvisionalLiveTranscript(
      {
        id: 'preview-0',
        sessionId: 'session-preview',
        channelId: 'source-ru',
        language: 'ru',
        text: 'Первое',
        sourceStartMs: 0,
        sourceEndMs: 900,
        emittedAt: new Date().toISOString(),
        revision: 1,
        phase: 'transcribing',
        final: false,
        sequence: 0,
      },
      new Set(['channel-en']),
    );

    await engine.ingestTranscript({
      text: 'Первое предложение.',
      sourceStartMs: 0,
      sourceEndMs: 2_000,
      final: true,
      sequence: 0,
    });
    await engine.ingestTranscript({
      text: 'Второе предложение.',
      sourceStartMs: 2_000,
      sourceEndMs: 4_000,
      final: true,
      sequence: 1,
    });

    expect(renderer.pending.map((item) => item.segment.sequence)).toEqual([0, 1]);
    expect(
      captions
        .filter((segment) => segment.channelId === 'channel-en' && !segment.final)
        .map((segment) => segment.sequence),
    ).toEqual([0, 0, 1]);

    renderer.resolve(1);
    renderer.resolve(0);
    await engine.stop();

    expect(audio.map((chunk) => chunk.sequence)).toEqual([0, 1]);
    expect(
      captions
        .filter((segment) => segment.channelId === 'channel-en' && segment.final)
        .map((segment) => segment.sequence),
    ).toEqual([0, 1]);
    expect(
      captions
        .filter((segment) => segment.channelId === 'channel-en' && segment.final)
        .every((segment) => segment.playout?.words.length),
    ).toBe(true);
    expect(
      transcripts
        .filter((segment) => segment.channelId === 'channel-en')
        .every((segment) => segment.final),
    ).toBe(true);
  });
});
