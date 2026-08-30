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
  sourcePauseAfterMs?: number;
  text?: string;
  sequence?: number;
  revision?: number;
}

interface CommittedWindow {
  startMs: number;
  endMs: number;
  sourcePauseAfterMs?: number;
}

export interface TranscriptionSecretProvider {
  create(input: { model: string; sourceLanguage: 'en' | 'ru' }): Promise<string>;
}

class OpenAITranscriptionSecretProvider implements TranscriptionSecretProvider {
  readonly #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({ apiKey });
  }

  async create(input: Parameters<TranscriptionSecretProvider['create']>[0]): Promise<string> {
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
            transcription: {
              model: input.model,
              prompt,
              keywords: ['Bible', 'Gospel', 'Scripture', 'Библия', 'Евангелие', 'Писание'],
              languages: [input.sourceLanguage],
              delay: 'low',
            },
            // GPT-Live-Transcribe currently rejects turn detection. Commit supported
            // fixed windows here, then join them into complete sentences downstream.
            turn_detection: null,
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
  readonly #committedWindows: CommittedWindow[] = [];
  readonly #unassignedItemIds: string[] = [];
  readonly #drainWaiters = new Set<() => void>();
  #connection: RealtimeConnection | undefined;
  #session?: ServiceSession;
  #sequence = 0;
  #lastAudioEndMs = 0;
  readonly #stopDrainMs: number;
  readonly #commitIntervalMs: number;
  #commitWindowStartMs = 0;
  #pendingCommits = 0;
  #stopping = false;

  constructor(
    apiKey: string,
    model: string,
    options: {
      secretProvider?: TranscriptionSecretProvider;
      connectionFactory?: RealtimeConnectionFactory;
      stopDrainMs?: number;
      commitIntervalMs?: number;
    } = {},
  ) {
    this.#model = model;
    this.name = `openai-live-transcribe:${model}`;
    this.#secretProvider = options.secretProvider ?? new OpenAITranscriptionSecretProvider(apiKey);
    this.#connectionFactory = options.connectionFactory ?? createWebSocketRealtimeConnection;
    this.#stopDrainMs = options.stopDrainMs ?? 15_000;
    this.#commitIntervalMs = options.commitIntervalMs ?? 3_500;
  }

  async start(session: ServiceSession): Promise<void> {
    if (this.#connection) throw new Error('Live transcription session is already running.');
    this.#session = session;
    this.#stopping = false;
    this.#sequence = 0;
    this.#lastAudioEndMs = 0;
    this.#commitWindowStartMs = 0;
    this.#pendingCommits = 0;
    this.#itemTiming.clear();
    this.#committedWindows.splice(0);
    this.#unassignedItemIds.splice(0);
    this.#drainWaiters.clear();
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
    if (this.#lastAudioEndMs - this.#commitWindowStartMs >= this.#commitIntervalMs) {
      this.#commit(this.#lastAudioEndMs);
    }
  }

  flushAudio(sourcePauseAfterMs?: number): void {
    if (!this.#connection || this.#lastAudioEndMs <= this.#commitWindowStartMs) return;
    this.#commit(this.#lastAudioEndMs, this.#connection, sourcePauseAfterMs);
  }

  async stop(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (!connection) return;
    this.#stopping = true;
    if (this.#lastAudioEndMs > this.#commitWindowStartMs) {
      this.#commit(this.#lastAudioEndMs, connection);
    }
    if (this.#stopDrainMs > 0 && this.#pendingCommits > 0) {
      await this.#waitForDrain(this.#stopDrainMs);
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
    if (event.type === 'conversation.item.input_audio_transcription.delta' && itemId) {
      const timing = this.#timingForItem(itemId);
      timing.firstDeltaAtUnixMs ??= Date.now();
      timing.sequence ??= this.#sequence++;
      timing.revision = (timing.revision ?? 0) + 1;
      if (typeof event.delta === 'string') timing.text = `${timing.text ?? ''}${event.delta}`;
      this.#itemTiming.set(itemId, timing);
      const text = timing.text?.trim();
      if (text && this.#session) {
        const sourceStartMs = Math.max(0, Math.round(timing.startMs ?? this.#lastAudioEndMs));
        const sourceEndMs = Math.max(
          sourceStartMs + 1,
          Math.round(timing.endMs ?? this.#lastAudioEndMs),
        );
        const segment: TranscriptSegment = {
          id: itemId,
          sessionId: this.#session.id,
          channelId: `source-${this.#session.sourceLanguage}`,
          language: this.#session.sourceLanguage,
          text,
          sourceStartMs,
          sourceEndMs,
          emittedAt: new Date().toISOString(),
          firstDeltaAtUnixMs: timing.firstDeltaAtUnixMs,
          revision: timing.revision,
          phase: 'transcribing',
          ...(timing.sourcePauseAfterMs !== undefined
            ? { sourcePauseAfterMs: timing.sourcePauseAfterMs }
            : {}),
          final: false,
          sequence: timing.sequence,
        };
        for (const listener of this.#segmentListeners) listener(segment);
      }
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
    this.#pendingCommits = Math.max(0, this.#pendingCommits - 1);
    if (this.#pendingCommits === 0) {
      for (const resolve of this.#drainWaiters) resolve();
      this.#drainWaiters.clear();
    }
    if (!text) return;
    const timing = this.#timingForItem(itemId);
    timing.sequence ??= this.#sequence++;
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
      ...(timing.sourcePauseAfterMs !== undefined
        ? { sourcePauseAfterMs: timing.sourcePauseAfterMs }
        : {}),
      final: true,
      sequence: timing.sequence,
    };
    for (const listener of this.#segmentListeners) listener(segment);
    this.#itemTiming.delete(itemId);
  }

  #commit(endMs: number, connection = this.#connection, sourcePauseAfterMs?: number): void {
    if (!connection || endMs <= this.#commitWindowStartMs) return;
    const window: CommittedWindow = {
      startMs: this.#commitWindowStartMs,
      endMs,
      ...(sourcePauseAfterMs !== undefined ? { sourcePauseAfterMs } : {}),
    };
    const itemId = this.#unassignedItemIds.shift();
    if (itemId) {
      this.#itemTiming.set(itemId, { ...this.#itemTiming.get(itemId), ...window });
    } else {
      this.#committedWindows.push(window);
    }
    connection.send({ type: 'input_audio_buffer.commit' });
    this.#pendingCommits += 1;
    this.#commitWindowStartMs = endMs;
  }

  #timingForItem(itemId: string): ItemTiming {
    const existing = this.#itemTiming.get(itemId);
    if (existing) return existing;
    const window = this.#committedWindows.shift();
    if (window) return { ...window };
    this.#unassignedItemIds.push(itemId);
    return {};
  }

  async #waitForDrain(timeoutMs: number): Promise<void> {
    if (this.#pendingCommits === 0) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        this.#drainWaiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.#drainWaiters.add(finish);
    });
  }
}
