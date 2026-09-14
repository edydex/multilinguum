import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioChunk,
  ChannelConfig,
  RealtimeTranscriptDelta,
  RenderedSpeech,
  ServiceSession,
  TranscriptSegment,
} from '@multilinguum/protocol';
import { OpenAILiveTranscriber } from './openai-live-transcriber.js';
import { OpenAIRealtimeTranslationChannel } from './openai-realtime-translation.js';
import type {
  RealtimeConnection,
  RealtimeConnectionFactory,
  RealtimeEvent,
} from './realtime-transport.js';

class FakeRealtimeConnection implements RealtimeConnection {
  readonly sent: unknown[] = [];
  readonly #listeners = new Set<(event: RealtimeEvent) => void>();
  readonly #waiters = new Map<string, Array<(event: RealtimeEvent) => void>>();
  readonly #autoUpdate: boolean;
  readonly #autoClose: boolean;
  closed = false;

  constructor(options: { autoUpdate?: boolean; autoClose?: boolean } = {}) {
    this.#autoUpdate = options.autoUpdate ?? false;
    this.#autoClose = options.autoClose ?? false;
  }

  async open(): Promise<void> {
    queueMicrotask(() => this.emit({ type: 'session.created' }));
  }

  send(event: unknown): void {
    this.sent.push(event);
    const type = (event as { type?: string }).type;
    if (type === 'session.update' && this.#autoUpdate) {
      queueMicrotask(() => this.emit({ type: 'session.updated' }));
    }
    if (type === 'session.close' && this.#autoClose) {
      queueMicrotask(() => this.emit({ type: 'session.closed' }));
    }
  }

  waitFor(type: string): Promise<RealtimeEvent> {
    return new Promise((resolve) => {
      this.#waiters.set(type, [...(this.#waiters.get(type) ?? []), resolve]);
    });
  }

  onEvent(listener: (event: RealtimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: RealtimeEvent): void {
    for (const listener of this.#listeners) listener(event);
    this.#waiters.get(event.type ?? '')?.shift()?.(event);
  }
}

function session(): ServiceSession {
  return {
    id: 'session-test',
    state: 'live',
    sourceLanguage: 'ru',
    targets: [],
    processingNode: {
      id: 'processor-test',
      name: 'Processor',
      mode: 'remote',
      endpoint: 'https://processor.example.test',
      identityFingerprint: '0123456789abcdef',
    },
    createdAt: new Date().toISOString(),
    relayRoom: 'service-test',
    contextDocumentIds: [],
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

function channel(): ChannelConfig {
  return {
    id: 'translated-en',
    targetLanguage: 'en',
    translationProvider: 'openai-realtime',
    voiceMode: 'natural',
    fallbackOrder: ['natural', 'mute'],
    muted: false,
  };
}

function captureChunk(endMs = 1): AudioChunk {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setInt16(0, 1_000, true);
  view.setInt16(2, 3_000, true);
  view.setInt16(4, -1_000, true);
  view.setInt16(6, -3_000, true);
  return {
    data,
    encoding: 'pcm_s16le',
    sampleRate: 48_000,
    startMs: 0,
    endMs,
    sequence: 0,
  };
}

describe('OpenAI Realtime provider adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['gpt-transcribe', 'gpt-live-transcribe'])(
    'creates a supported transcription session for %s',
    async (model) => {
      const requests: Array<{
        session: { audio: { input: { transcription: Record<string, unknown> } } };
      }> = [];
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
        requests.push(await request.json());
        return new Response(JSON.stringify({ value: 'fixture-ephemeral-secret' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const connection = new FakeRealtimeConnection();
      const transcriber = new OpenAILiveTranscriber('fixture-project-key', model, {
        connectionFactory: () => connection,
        stopDrainMs: 0,
      });
      await transcriber.start(session());
      await transcriber.stop();
      expect(requests).toHaveLength(1);
      const transcription = requests[0]!.session.audio.input.transcription;
      expect(transcription).toMatchObject({ model, languages: ['ru'] });
      if (model === 'gpt-transcribe') expect(transcription).not.toHaveProperty('delay');
      else expect(transcription.delay).toBe('low');
    },
  );

  it('keeps committed audio order when later recognition finishes first', async () => {
    const connection = new FakeRealtimeConnection();
    const transcriber = new OpenAILiveTranscriber('fixture-key', 'gpt-transcribe', {
      connectionFactory: () => connection,
      secretProvider: { create: async () => 'fixture-ephemeral-secret' },
      stopDrainMs: 0,
      commitIntervalMs: 3_000,
    });
    const finals: TranscriptSegment[] = [];
    transcriber.onSegment((segment) => {
      if (segment.final) finals.push(segment);
    });
    await transcriber.start(session());
    await transcriber.pushAudio(captureChunk(3_000));
    connection.emit({ type: 'input_audio_buffer.committed', item_id: 'first' });
    await transcriber.pushAudio(captureChunk(6_000));
    connection.emit({
      type: 'input_audio_buffer.committed',
      item_id: 'second',
      previous_item_id: 'first',
    });
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'second',
      transcript: 'Then the conclusion.',
    });
    expect(finals).toHaveLength(0);
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'first',
      transcript: 'First the premise.',
    });
    expect(
      finals.map(({ text, sequence, sourceStartMs, sourceEndMs }) => ({
        text,
        sequence,
        sourceStartMs,
        sourceEndMs,
      })),
    ).toEqual([
      { text: 'First the premise.', sequence: 0, sourceStartMs: 0, sourceEndMs: 3_000 },
      { text: 'Then the conclusion.', sequence: 1, sourceStartMs: 3_000, sourceEndMs: 6_000 },
    ]);
    await transcriber.stop();
  });

  it.each(['empty', 'failed'])(
    'retires an %s turn without losing later text or replaying duplicates',
    async (kind) => {
      const connection = new FakeRealtimeConnection();
      const transcriber = new OpenAILiveTranscriber('fixture-key', 'gpt-transcribe', {
        connectionFactory: () => connection,
        secretProvider: { create: async () => 'fixture-secret' },
        stopDrainMs: 0,
        commitIntervalMs: 3_000,
      });
      const finals: TranscriptSegment[] = [];
      const errors: Error[] = [];
      transcriber.onSegment((segment) => {
        if (segment.final) finals.push(segment);
      });
      transcriber.onError((error) => errors.push(error));
      await transcriber.start(session());
      for (const [index, id] of ['first', 'second'].entries()) {
        await transcriber.pushAudio(captureChunk((index + 1) * 3_000));
        connection.emit({ type: 'input_audio_buffer.committed', item_id: id });
      }
      const later = {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'second',
        transcript: 'The next sentence.',
      };
      connection.emit(later);
      expect(finals).toHaveLength(0);
      connection.emit(
        kind === 'empty'
          ? {
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: 'first',
              transcript: '',
            }
          : {
              type: 'conversation.item.input_audio_transcription.failed',
              item_id: 'first',
              error: { message: 'Recognition failed.' },
            },
      );
      connection.emit(later);
      expect(finals).toHaveLength(1);
      expect(finals[0]).toMatchObject({ sequence: 1, sourceStartMs: 3_000, sourceEndMs: 6_000 });
      expect(errors).toHaveLength(kind === 'failed' ? 1 : 0);
      await transcriber.stop();
    },
  );

  it('retains early partial text timing when its audio is committed later', async () => {
    const connection = new FakeRealtimeConnection();
    const transcriber = new OpenAILiveTranscriber('fixture-key', 'gpt-live-transcribe', {
      connectionFactory: () => connection,
      secretProvider: { create: async () => 'fixture-secret' },
      stopDrainMs: 0,
    });
    const segments: TranscriptSegment[] = [];
    transcriber.onSegment((segment) => segments.push(segment));
    await transcriber.start(session());
    await transcriber.pushAudio(captureChunk(2_000));
    connection.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'early',
      delta: 'Grace',
    });
    transcriber.flushAudio(360);
    connection.emit({ type: 'input_audio_buffer.committed', item_id: 'early' });
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'early',
      transcript: 'Grace and peace.',
    });
    expect(segments.at(-1)).toMatchObject({
      final: true,
      sequence: 0,
      sourceStartMs: 0,
      sourceEndMs: 2_000,
      sourcePauseAfterMs: 360,
    });
    await transcriber.stop();
  });

  it('reports a missing turn and releases later text instead of stalling the rest of the service', async () => {
    vi.useFakeTimers();
    const connection = new FakeRealtimeConnection();
    const transcriber = new OpenAILiveTranscriber('fixture-key', 'gpt-transcribe', {
      connectionFactory: () => connection,
      secretProvider: { create: async () => 'fixture-secret' },
      stopDrainMs: 0,
      commitIntervalMs: 3_000,
    });
    const finals: TranscriptSegment[] = [];
    const errors: Error[] = [];
    transcriber.onSegment((segment) => {
      if (segment.final) finals.push(segment);
    });
    transcriber.onError((error) => errors.push(error));
    await transcriber.start(session());
    for (const [index, id] of ['missing', 'later'].entries()) {
      await transcriber.pushAudio(captureChunk((index + 1) * 3_000));
      connection.emit({ type: 'input_audio_buffer.committed', item_id: id });
    }
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'later',
      transcript: 'The next sentence.',
    });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(errors).toHaveLength(1);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ sequence: 1, text: 'The next sentence.' });
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'missing',
      transcript: 'Stale late result.',
    });
    expect(finals).toHaveLength(1);
    await transcriber.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets committed-turn recognition wait past eight seconds for a natural pause', async () => {
    const connection = new FakeRealtimeConnection();
    const transcriber = new OpenAILiveTranscriber('fixture-key', 'gpt-transcribe', {
      connectionFactory: () => connection,
      secretProvider: { create: async () => 'fixture-secret' },
      stopDrainMs: 0,
    });
    await transcriber.start(session());
    await transcriber.pushAudio(captureChunk(8_000));
    await transcriber.pushAudio(captureChunk(10_000));
    expect(connection.sent).toHaveLength(2);
    transcriber.flushAudio(360);
    expect(connection.sent[2]).toEqual({ type: 'input_audio_buffer.commit' });
    await transcriber.stop();
  });

  it('normalizes explicitly committed live transcription windows into finalized segments', async () => {
    const connection = new FakeRealtimeConnection();
    const factory: RealtimeConnectionFactory = () => connection;
    const transcriber = new OpenAILiveTranscriber('not-used-in-test', 'gpt-live-transcribe', {
      connectionFactory: factory,
      secretProvider: { create: async () => 'short-lived-test-secret' },
      stopDrainMs: 0,
      commitIntervalMs: 3_000,
    });
    const segments: TranscriptSegment[] = [];
    transcriber.onSegment((segment) => segments.push(segment));

    await transcriber.start(session());
    await transcriber.pushAudio(captureChunk(3_000));
    connection.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'Благодать',
    });
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'Благодать вам и мир.',
    });

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      text: 'Благодать',
      revision: 1,
      phase: 'transcribing',
      final: false,
      sequence: 0,
    });
    expect(segments[1]).toMatchObject({
      sessionId: 'session-test',
      channelId: 'source-ru',
      language: 'ru',
      text: 'Благодать вам и мир.',
      sourceStartMs: 0,
      sourceEndMs: 3_000,
      firstDeltaAtUnixMs: expect.any(Number),
      final: true,
      sequence: 0,
    });
    const append = connection.sent[0] as { type: string; audio: string };
    expect(append.type).toBe('input_audio_buffer.append');
    const downsampled = Buffer.from(append.audio, 'base64');
    expect([...downsampled]).toEqual([0xd0, 0x07, 0x30, 0xf8]);
    expect(connection.sent[1]).toEqual({ type: 'input_audio_buffer.commit' });
    await transcriber.stop();
    expect(connection.closed).toBe(true);
  });

  it('carries a detected source pause into provisional and finalized segments', async () => {
    const connection = new FakeRealtimeConnection();
    const transcriber = new OpenAILiveTranscriber('not-used-in-test', 'gpt-live-transcribe', {
      connectionFactory: () => connection,
      secretProvider: { create: async () => 'short-lived-test-secret' },
      stopDrainMs: 0,
      commitIntervalMs: 8_000,
    });
    const segments: TranscriptSegment[] = [];
    transcriber.onSegment((segment) => segments.push(segment));

    await transcriber.start(session());
    await transcriber.pushAudio(captureChunk(2_000));
    transcriber.flushAudio(420);
    connection.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'pause-item',
      delta: 'Поэтому мы помним,',
    });
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'pause-item',
      transcript: 'Поэтому мы помним,',
    });

    expect(connection.sent[1]).toEqual({ type: 'input_audio_buffer.commit' });
    expect(segments.map((segment) => segment.sourcePauseAfterMs)).toEqual([420, 420]);
    await transcriber.stop();
  });

  it('uses longer supported commit windows for sentence-aware downstream buffering', async () => {
    const connection = new FakeRealtimeConnection();
    const transcriber = new OpenAILiveTranscriber('not-used-in-test', 'gpt-live-transcribe', {
      connectionFactory: () => connection,
      secretProvider: { create: async () => 'short-lived-test-secret' },
      stopDrainMs: 0,
      commitIntervalMs: 8_000,
    });
    const segments: TranscriptSegment[] = [];
    transcriber.onSegment((segment) => segments.push(segment));

    await transcriber.start(session());
    await transcriber.pushAudio(captureChunk(3_000));
    expect(connection.sent).toHaveLength(1);
    await transcriber.pushAudio(captureChunk(8_000));
    expect(connection.sent[2]).toEqual({ type: 'input_audio_buffer.commit' });
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'window-item',
      transcript: 'Кротость — это внешняя реакция.',
    });

    expect(segments[0]).toMatchObject({ sourceStartMs: 0, sourceEndMs: 8_000 });
    await transcriber.stop();
    expect(connection.closed).toBe(true);
  });

  it('normalizes translated transcript and 24 kHz PCM output without provider events leaking', async () => {
    const connection = new FakeRealtimeConnection({ autoUpdate: true, autoClose: true });
    const factory: RealtimeConnectionFactory = () => connection;
    const translator = new OpenAIRealtimeTranslationChannel(
      'project-key-test',
      'gpt-realtime-translate',
      { connectionFactory: factory },
    );
    const transcripts: RealtimeTranscriptDelta[] = [];
    const audio: RenderedSpeech[] = [];
    translator.onTranscriptDelta((delta) => transcripts.push(delta));
    translator.onAudio((frame) => audio.push(frame));

    await translator.start(session(), channel());
    await translator.pushAudio(captureChunk());
    connection.emit({
      type: 'session.output_transcript.delta',
      delta: 'Grace to you',
      elapsed_ms: 1_200,
    });
    const pcm24k = new Uint8Array(4);
    const view = new DataView(pcm24k.buffer);
    view.setInt16(0, 1_000, true);
    view.setInt16(2, 3_000, true);
    connection.emit({
      type: 'session.output_audio.delta',
      delta: Buffer.from(pcm24k).toString('base64'),
      elapsed_ms: 1_200,
      sample_rate: 24_000,
    });

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({
      sessionId: 'session-test',
      channelId: 'translated-en',
      language: 'en',
      delta: 'Grace to you',
      sourceElapsedMs: 1_200,
    });
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({
      encoding: 'pcm_s16le',
      sampleRate: 48_000,
      startMs: 1_200,
      sequence: 0,
      language: 'en',
    });
    expect([...new Int16Array(audio[0]?.data.buffer)]).toEqual([1_000, 2_000, 3_000, 3_000]);
    expect(
      connection.sent.some(
        (event) => (event as { type?: string }).type === 'session.input_audio_buffer.append',
      ),
    ).toBe(true);
    translator.cancel();
    expect(connection.closed).toBe(true);
    connection.emit({ type: 'session.output_transcript.delta', delta: 'Late output' });
    expect(transcripts).toHaveLength(1);
    await translator.stop();
  });
});
