import { describe, expect, it } from 'vitest';
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

function captureChunk(): AudioChunk {
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
    endMs: 1,
    sequence: 0,
  };
}

describe('OpenAI Realtime provider adapters', () => {
  it('normalizes live transcription VAD timing into finalized source segments', async () => {
    const connection = new FakeRealtimeConnection();
    const factory: RealtimeConnectionFactory = () => connection;
    const transcriber = new OpenAILiveTranscriber('not-used-in-test', 'gpt-live-transcribe', {
      connectionFactory: factory,
      secretProvider: { create: async () => 'short-lived-test-secret' },
      stopDrainMs: 0,
    });
    const segments: TranscriptSegment[] = [];
    transcriber.onSegment((segment) => segments.push(segment));

    await transcriber.start(session());
    await transcriber.pushAudio(captureChunk());
    connection.emit({
      type: 'input_audio_buffer.speech_started',
      item_id: 'item-1',
      audio_start_ms: 200,
    });
    connection.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'Благодать',
    });
    connection.emit({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'item-1',
      audio_end_ms: 1_600,
    });
    connection.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'Благодать вам и мир.',
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      sessionId: 'session-test',
      channelId: 'source-ru',
      language: 'ru',
      text: 'Благодать вам и мир.',
      sourceStartMs: 200,
      sourceEndMs: 1_600,
      final: true,
      sequence: 0,
    });
    const append = connection.sent[0] as { type: string; audio: string };
    expect(append.type).toBe('input_audio_buffer.append');
    const downsampled = Buffer.from(append.audio, 'base64');
    expect([...downsampled]).toEqual([0xd0, 0x07, 0x30, 0xf8]);
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
    await translator.stop();
    expect(connection.closed).toBe(true);
  });
});
