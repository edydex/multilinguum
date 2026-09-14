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
  sequence: number;
  revision?: number;
}

interface CommittedWindow {
  startMs: number;
  endMs: number;
  sequence: number;
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
              ...(input.model === 'gpt-transcribe' ? {} : { delay: 'low' as const }),
            },
            // The capture pipeline commits at detected pauses; the adapter also
            // bounds uninterrupted speech. Keep provider-side turn detection off.
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
  readonly #completedItems = new Set<string>();
  readonly #completedSegments = new Map<number, TranscriptSegment | null>();
  readonly #pendingWindows = new Map<number, ReturnType<typeof setTimeout>>();
  #nextFinalSequence = 0;
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
    // Committed-turn recognition needs a complete phrase. Natural pauses in the
    // capture pipeline normally commit much sooner than this emergency ceiling.
    // An eight-second forced cut lost words in the real sermon/English fixtures.
    this.#commitIntervalMs =
      options.commitIntervalMs ?? (model === 'gpt-transcribe' ? 30_000 : 8_000);
  }

  async start(session: ServiceSession): Promise<void> {
    if (this.#connection) throw new Error('Live transcription session is already running.');
    this.#session = session;
    this.#stopping = false;
    this.#sequence = 0;
    this.#nextFinalSequence = 0;
    this.#completedItems.clear();
    this.#completedSegments.clear();
    for (const timer of this.#pendingWindows.values()) clearTimeout(timer);
    this.#pendingWindows.clear();
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
      if (this.#pendingCommits > 0) {
        this.#reportError(new Error('Transcription stopped before all committed audio finished.'));
      }
    }
    connection.close();
    for (const timer of this.#pendingWindows.values()) clearTimeout(timer);
    this.#pendingWindows.clear();
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
      this.#reportError(error);
      return;
    }
    const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
    if (itemId && this.#completedItems.has(itemId)) return;
    if (event.type === 'input_audio_buffer.committed' && itemId) {
      const existing = this.#itemTiming.get(itemId);
      if (existing?.startMs !== undefined) return;
      const window = this.#committedWindows.shift();
      if (window) {
        if (this.#pendingWindows.has(window.sequence))
          this.#itemTiming.set(itemId, { ...existing, ...window });
        else this.#rememberCompletedItem(itemId);
      }
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed' && itemId) {
      const timing = this.#timingForItem(itemId);
      if (timing.startMs !== undefined && !this.#pendingWindows.has(timing.sequence)) return;
      this.#completeItem(itemId, timing, null);
      const detail = event.error as { message?: unknown } | undefined;
      this.#reportError(
        new Error(
          typeof detail?.message === 'string'
            ? detail.message
            : 'A committed audio turn could not be transcribed.',
        ),
      );
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta' && itemId) {
      const timing = this.#timingForItem(itemId);
      if (timing.startMs !== undefined && !this.#pendingWindows.has(timing.sequence)) return;
      timing.firstDeltaAtUnixMs ??= Date.now();
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
    const timing = this.#timingForItem(itemId);
    if (timing.startMs !== undefined && !this.#pendingWindows.has(timing.sequence)) return;
    if (!text) {
      this.#completeItem(itemId, timing, null);
      return;
    }
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
    this.#completeItem(itemId, timing, segment);
  }

  #commit(endMs: number, connection = this.#connection, sourcePauseAfterMs?: number): void {
    if (!connection || endMs <= this.#commitWindowStartMs) return;
    const itemId = this.#unassignedItemIds.shift();
    const existing = itemId ? this.#itemTiming.get(itemId) : undefined;
    const window: CommittedWindow = {
      startMs: this.#commitWindowStartMs,
      endMs,
      sequence: existing?.sequence ?? this.#sequence++,
      ...(sourcePauseAfterMs !== undefined ? { sourcePauseAfterMs } : {}),
    };
    if (itemId) {
      this.#itemTiming.set(itemId, { ...this.#itemTiming.get(itemId), ...window });
    } else {
      this.#committedWindows.push(window);
    }
    this.#pendingCommits += 1;
    this.#commitWindowStartMs = endMs;
    this.#pendingWindows.set(
      window.sequence,
      setTimeout(() => {
        this.#reportError(new Error('A committed audio turn did not finish within 30 seconds.'));
        for (const [id, timing] of this.#itemTiming) {
          if (timing.sequence === window.sequence) {
            this.#rememberCompletedItem(id);
            this.#itemTiming.delete(id);
          }
        }
        this.#finishWindow(window.sequence, null);
      }, 30_000),
    );
    connection.send({ type: 'input_audio_buffer.commit' });
  }

  #timingForItem(itemId: string): ItemTiming {
    const existing = this.#itemTiming.get(itemId);
    if (existing) return existing;
    const window = this.#committedWindows.shift();
    const timing = window ? { ...window } : { sequence: this.#sequence++ };
    if (!window) this.#unassignedItemIds.push(itemId);
    this.#itemTiming.set(itemId, timing);
    return timing;
  }

  #completeItem(itemId: string, timing: ItemTiming, segment: TranscriptSegment | null): void {
    this.#rememberCompletedItem(itemId);
    this.#itemTiming.delete(itemId);
    this.#finishWindow(timing.sequence, segment);
  }

  #rememberCompletedItem(itemId: string): void {
    this.#completedItems.add(itemId);
    // Retain recent IDs to ignore duplicate acknowledgements/completions without
    // accumulating a service's entire history in memory.
    if (this.#completedItems.size > 1_024) {
      this.#completedItems.delete(this.#completedItems.values().next().value!);
    }
  }

  #finishWindow(sequence: number, segment: TranscriptSegment | null): void {
    clearTimeout(this.#pendingWindows.get(sequence));
    this.#pendingWindows.delete(sequence);
    this.#completedSegments.set(sequence, segment);
    while (this.#completedSegments.has(this.#nextFinalSequence)) {
      const next = this.#completedSegments.get(this.#nextFinalSequence);
      this.#completedSegments.delete(this.#nextFinalSequence++);
      if (next) for (const listener of this.#segmentListeners) listener(next);
    }
    this.#pendingCommits = Math.max(0, this.#pendingCommits - 1);
    if (this.#pendingCommits === 0) {
      for (const resolve of this.#drainWaiters) resolve();
      this.#drainWaiters.clear();
    }
  }

  #reportError(error: Error): void {
    for (const listener of this.#errorListeners) listener(error);
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
