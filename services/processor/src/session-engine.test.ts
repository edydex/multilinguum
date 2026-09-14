import { describe, expect, it, vi } from 'vitest';
import type {
  ArchiveManifest,
  ChannelConfig,
  MediaRelay,
  RenderedSpeech,
  ServiceSession,
  SpeechRenderer,
  SpeechRenderContext,
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
    reject: (error: Error) => void;
    signal: AbortSignal | undefined;
  }> = [];

  render(
    segment: TranscriptSegment,
    _profile?: never,
    context?: SpeechRenderContext,
  ): Promise<RenderedSpeech> {
    return new Promise((resolve, reject) =>
      this.pending.push({ segment, resolve, reject, signal: context?.signal }),
    );
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

async function fixture(
  source: 'en' | 'ru' = 'ru',
  speechEnabled = true,
  recording: { source?: boolean; translations?: boolean; realtime?: boolean } = {},
) {
  const captions: TranscriptSegment[] = [];
  const audio: RenderedSpeech[] = [];
  const recordedAudio: Array<{ channelId: string; audio: RenderedSpeech }> = [];
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
    clearAudio: vi.fn(),
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
      appendAudio: async (_sessionId, channelId, audio) => {
        recordedAudio.push({ channelId, audio });
      },
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
      id: `channel-${source}`,
      targetLanguage: source,
      translationProvider: 'openai-cascade',
      voiceMode: 'source',
      fallbackOrder: ['mute'],
      muted: false,
      speechEnabled,
    },
    {
      id: `channel-${source === 'ru' ? 'en' : 'ru'}`,
      targetLanguage: source === 'ru' ? 'en' : 'ru',
      translationProvider: recording.realtime ? 'openai-realtime' : 'openai-cascade',
      voiceMode: 'natural',
      fallbackOrder: ['mute'],
      muted: false,
      speechEnabled,
    },
  ];
  await engine.create({
    sourceLanguage: source,
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
      recordSource: recording.source ?? true,
      recordTranslations: recording.translations ?? true,
    },
    contextDocumentIds: [],
    expectedDurationMinutes: 1,
    budgetWarningUsd: 20,
  });
  await engine.start();
  return { engine, renderer, captions, audio, recordedAudio, transcripts, relay };
}

function ingest(engine: SessionEngine, sequence: number) {
  return engine.ingestTranscript({
    text: 'Grace and peace to you.',
    sourceStartMs: sequence * 2000,
    sourceEndMs: (sequence + 1) * 2000,
    final: true,
    sequence,
  });
}

describe('SessionEngine independent text and audio', () => {
  it('records requested source audio while source playback is off', async () => {
    const { engine, audio, recordedAudio } = await fixture('ru', false);
    await engine.ingestSourceAudio({
      data: new Uint8Array(960),
      startMs: 0,
      endMs: 10,
      sequence: 0,
      language: 'ru',
    });
    await engine.stop();
    expect(audio).toHaveLength(0);
    expect(recordedAudio.map((item) => item.channelId)).toEqual(['channel-ru']);
  });

  it('plays source and generated audio without recording when recording is off', async () => {
    const { engine, renderer, audio, recordedAudio } = await fixture('ru', true, {
      source: false,
      translations: false,
    });
    await engine.ingestSourceAudio({
      data: new Uint8Array(960),
      startMs: 0,
      endMs: 10,
      sequence: 0,
      language: 'ru',
    });
    await ingest(engine, 0);
    renderer.resolve(0);
    await engine.stop();
    expect(audio).toHaveLength(2);
    expect(recordedAudio).toHaveLength(0);
  });

  it.each([false, true])(
    'respects translated recording=%s for direct realtime audio',
    async (enabled) => {
      const { engine, audio, recordedAudio } = await fixture('ru', true, {
        translations: enabled,
        realtime: true,
      });
      await engine.ingestRealtimeAudio('channel-en', {
        data: new Uint8Array(960),
        encoding: 'pcm_s16le',
        sampleRate: 48000,
        startMs: 0,
        endMs: 10,
        sequence: 0,
        language: 'en',
        renderer: 'direct-realtime',
      });
      await engine.stop();
      expect(audio).toHaveLength(1);
      expect(recordedAudio).toHaveLength(enabled ? 1 : 0);
    },
  );

  it('publishes captions immediately and adds ordered speech timing after rendering', async () => {
    const { engine, renderer, captions, audio, transcripts } = await fixture();
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
    ).toEqual([]);

    expect(
      captions
        .filter((segment) => segment.channelId === 'channel-en' && segment.final)
        .map((segment) => segment.sequence),
    ).toEqual([0, 1]);
    expect(audio).toHaveLength(0);
    renderer.resolve(1);
    renderer.resolve(0);
    await engine.stop();

    expect(audio.map((chunk) => chunk.sequence)).toEqual([0, 1]);
    expect(
      captions
        .filter((segment) => segment.channelId === 'channel-en' && segment.phase === 'queued')
        .map((segment) => segment.sequence),
    ).toEqual([0, 1]);
    expect(
      captions
        .filter((segment) => segment.channelId === 'channel-en' && segment.phase === 'queued')
        .every((segment) => segment.playout?.words.length),
    ).toBe(true);
    expect(
      transcripts
        .filter((segment) => segment.channelId === 'channel-en')
        .every((segment) => segment.final),
    ).toBe(true);
  });

  it.each(['en', 'ru'] as const)(
    'translates %s with zero speech requests when audio is off',
    async (source) => {
      const { engine, renderer, captions, audio, transcripts } = await fixture(source, false);
      await ingest(engine, 0);
      await engine.ingestSourceAudio({
        data: new Uint8Array(960),
        startMs: 0,
        endMs: 10,
        sequence: 0,
        language: source,
      });
      await engine.stop();
      expect(renderer.pending).toHaveLength(0);
      expect(audio).toHaveLength(0);
      expect(captions.map((segment) => segment.language).sort()).toEqual(['en', 'ru']);
      expect(transcripts).toHaveLength(2);
    },
  );

  it('cancels pending speech, clears relay audio, and never replays it after enabling again', async () => {
    const { engine, renderer, captions, audio, relay } = await fixture();
    await ingest(engine, 0);
    await engine.setSpeechEnabled('channel-en', false);
    expect(renderer.pending[0]!.signal?.aborted).toBe(true);
    expect(relay.clearAudio).toHaveBeenCalledWith('channel-en');
    expect(
      engine.current()?.targets.find((channel) => channel.id === 'channel-en')?.speechEnabled,
    ).toBe(false);
    await ingest(engine, 1);
    expect(renderer.pending).toHaveLength(1);
    expect(captions.filter((segment) => segment.channelId === 'channel-en')).toHaveLength(2);
    await engine.setSpeechEnabled('channel-en', true);
    await ingest(engine, 2);
    // A provider ignoring AbortSignal must not stall the new queue or publish stale speech.
    renderer.resolve(2);
    await engine.drainAudio();
    expect(audio.map((chunk) => chunk.sequence)).toEqual([2]);
    renderer.resolve(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audio.map((chunk) => chunk.sequence)).toEqual([2]);
    expect(
      engine.current()?.targets.find((channel) => channel.id === 'channel-en')?.speechEnabled,
    ).toBe(true);
    await engine.stop();
  });

  it('keeps translated text available after speech generation fails', async () => {
    const { engine, renderer, captions, audio } = await fixture();
    await ingest(engine, 0);
    renderer.pending[0]!.reject(new Error('Speech provider unavailable'));
    await engine.drainAudio();
    expect(captions.find((segment) => segment.channelId === 'channel-en')?.text).toBe(
      'Translated 0',
    );
    expect(audio).toHaveLength(0);
    expect(engine.health().find((channel) => channel.channelId === 'channel-en')?.state).toBe(
      'degraded',
    );
    await engine.stop();
  });

  it('updates public session configuration and cancels pending speech on mute', async () => {
    const { engine, renderer, audio } = await fixture();
    await ingest(engine, 0);
    await engine.setMuted('channel-en', true);
    expect(engine.current()?.targets.find((channel) => channel.id === 'channel-en')?.muted).toBe(
      true,
    );
    renderer.resolve(0);
    await engine.stop();
    expect(audio).toHaveLength(0);
  });
});

it('carries capture time into captions and rendered speech when the microphone starts late', async () => {
  const { engine, renderer, captions, audio } = await fixture();
  const captureEnd = Date.parse(engine.current()!.startedAt!) + 32_000;
  await engine.ingestTranscript({
    text: 'Grace and peace to you.',
    sourceStartMs: 0,
    sourceEndMs: 2000,
    sequence: 0,
    final: true,
    timing: { captureCompletedAtUnixMs: captureEnd },
  });
  const translated = captions.find((item) => item.language === 'en')!;
  expect(translated.sourceStartAtUnixMs).toBe(captureEnd - 2000);
  expect(translated.sourceEndAtUnixMs).toBe(captureEnd);
  renderer.resolve(0);
  await engine.drainAudio();
  expect(audio[0]).toMatchObject({
    sourceStartAtUnixMs: captureEnd - 2000,
    sourceEndAtUnixMs: captureEnd,
  });
});
