import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type {
  AudioChunk,
  ServiceSession,
  TranscriptSegment,
  Transcriber,
} from '@multilinguum/protocol';
import {
  createWebSocketRealtimeConnection,
  downsamplePcm48kTo24k,
  type RealtimeConnection,
  type RealtimeConnectionFactory,
  type RealtimeEvent,
} from './realtime-transport.js';

interface ItemTiming {
  startMs?: number;
  endMs?: number;
  firstDeltaAtUnixMs?: number;
}

export interface TranscriptionSecretProvider {
  create(input: { model: string; sourceLanguage: 'en' | 'ru' }): Promise<string>;
}

class OpenAITranscriptionSecretProvider implements TranscriptionSecretProvider {
  readonly #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({ apiKey });
  }

  async create(input: { model: string; sourceLanguage: 'en' | 'ru' }): Promise<string> {
    const prompt =
      input.sourceLanguage === 'ru'
        ? 'Русская церковная проповедь. Библия, Евангелие, Господь, благодать, оправдание.'
        : 'English church sermon. Bible, Gospel, the Lord, grace, justification.';
    const response = await this.#client.realtime.clientSecrets.create({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            noise_reduction: { type: 'far_field' },
            transcription: {
              model: input.model,
              prompt,
              keywords: ['Bible', 'Gospel', 'Scripture', 'Библия', 'Евангелие', 'Писание'],
              languages: [input.sourceLanguage],
              delay: 'low',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.45,
              prefix_padding_ms: 300,
              silence_duration_ms: 650,
              create_response: false,
              interrupt_response: false,
            },
          },
        },
      },
    });
    return response.value;
  }
}

export class OpenAILiveTranscriber implements Transcriber {
  readonly name: string;
  readonly #model: string;
  readonly #secretProvider: TranscriptionSecretProvider;
  readonly #connectionFactory: RealtimeConnectionFactory;
  readonly #segmentListeners = new Set<(segment: TranscriptSegment) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #itemTiming = new Map<string, ItemTiming>();
  #connection: RealtimeConnection | undefined;
  #session?: ServiceSession;
  #sequence = 0;
  #lastAudioEndMs = 0;
  readonly #stopDrainMs: number;
  #stopping = false;

  constructor(
    apiKey: string,
    model: string,
    options: {
      secretProvider?: TranscriptionSecretProvider;
      connectionFactory?: RealtimeConnectionFactory;
      stopDrainMs?: number;
    } = {},
  ) {
    this.#model = model;
    this.name = `openai-live-transcribe:${model}`;
    this.#secretProvider = options.secretProvider ?? new OpenAITranscriptionSecretProvider(apiKey);
    this.#connectionFactory = options.connectionFactory ?? createWebSocketRealtimeConnection;
    this.#stopDrainMs = options.stopDrainMs ?? 2_000;
  }

  async start(session: ServiceSession): Promise<void> {
    if (this.#connection) throw new Error('Live transcription session is already running.');
    this.#session = session;
    this.#stopping = false;
    this.#sequence = 0;
    this.#lastAudioEndMs = 0;
    this.#itemTiming.clear();
    const secret = await this.#secretProvider.create({
      model: this.#model,
      sourceLanguage: session.sourceLanguage,
    });
    const connection = this.#connectionFactory({
      url: 'wss://api.openai.com/v1/realtime',
      bearerToken: secret,
      safetyIdentifier: 'multilinguum-live-transcription',
    });
    connection.onEvent((event) => this.#receive(event));
    this.#connection = connection;
    await connection.open();
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    if (!this.#connection) throw new Error('Live transcription session is not running.');
    if (chunk.encoding !== 'pcm_s16le') throw new Error('Live transcription requires PCM audio.');
    const data =
      chunk.sampleRate === 48_000
        ? downsamplePcm48kTo24k(chunk.data)
        : chunk.sampleRate === 24_000
          ? chunk.data
          : undefined;
    if (!data) throw new Error('Live transcription supports only 24 kHz or 48 kHz mono PCM.');
    this.#lastAudioEndMs = Math.max(this.#lastAudioEndMs, chunk.endMs);
    this.#connection.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(data).toString('base64'),
    });
  }

  async stop(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (!connection) return;
    this.#stopping = true;
    if (this.#stopDrainMs > 0 && this.#lastAudioEndMs > 0) {
      const completed = connection.waitFor(
        'conversation.item.input_audio_transcription.completed',
        this.#stopDrainMs,
      );
      connection.send({ type: 'input_audio_buffer.commit' });
      await completed.catch(() => undefined);
    }
    connection.close();
  }

  onSegment(listener: (segment: TranscriptSegment) => void): () => void {
    this.#segmentListeners.add(listener);
    return () => this.#segmentListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  #receive(event: RealtimeEvent): void {
    if (event.type === 'error') {
      if (this.#stopping) return;
      const detail = event.error as { message?: unknown } | undefined;
      const error = new Error(
        typeof detail?.message === 'string' ? detail.message : 'OpenAI live transcription failed.',
      );
      for (const listener of this.#errorListeners) listener(error);
      return;
    }
    const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
    if (event.type === 'input_audio_buffer.speech_started' && itemId) {
      this.#itemTiming.set(
        itemId,
        typeof event.audio_start_ms === 'number' ? { startMs: event.audio_start_ms } : {},
      );
      return;
    }
    if (event.type === 'input_audio_buffer.speech_stopped' && itemId) {
      const timing = this.#itemTiming.get(itemId) ?? {};
      if (typeof event.audio_end_ms === 'number') timing.endMs = event.audio_end_ms;
      this.#itemTiming.set(itemId, timing);
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta' && itemId) {
      const timing = this.#itemTiming.get(itemId) ?? {};
      timing.firstDeltaAtUnixMs ??= Date.now();
      this.#itemTiming.set(itemId, timing);
      return;
    }
    if (
      event.type !== 'conversation.item.input_audio_transcription.completed' ||
      !itemId ||
      typeof event.transcript !== 'string' ||
      !this.#session
    ) {
      return;
    }
    const text = event.transcript.trim();
    if (!text) return;
    const timing = this.#itemTiming.get(itemId) ?? {};
    const sourceStartMs = Math.max(0, Math.round(timing.startMs ?? this.#lastAudioEndMs));
    const sourceEndMs = Math.max(
      sourceStartMs + 1,
      Math.round(timing.endMs ?? this.#lastAudioEndMs),
    );
    const segment: TranscriptSegment = {
      id: randomUUID(),
      sessionId: this.#session.id,
      channelId: `source-${this.#session.sourceLanguage}`,
      language: this.#session.sourceLanguage,
      text,
      sourceStartMs,
      sourceEndMs,
      emittedAt: new Date().toISOString(),
      ...(timing.firstDeltaAtUnixMs !== undefined
        ? { firstDeltaAtUnixMs: timing.firstDeltaAtUnixMs }
        : {}),
      final: true,
      sequence: this.#sequence++,
    };
    for (const listener of this.#segmentListeners) listener(segment);
    this.#itemTiming.delete(itemId);
  }
}
