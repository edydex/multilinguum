import type {
  AudioChunk,
  ChannelConfig,
  RealtimeTranscriptDelta,
  RealtimeTranslationChannel,
  RenderedSpeech,
  ServiceSession,
} from '@multilinguum/protocol';
import {
  createWebSocketRealtimeConnection,
  downsamplePcm48kTo24k,
  upsamplePcm24kTo48k,
  type RealtimeConnection,
  type RealtimeConnectionFactory,
  type RealtimeEvent,
} from './realtime-transport.js';

export class OpenAIRealtimeTranslationChannel implements RealtimeTranslationChannel {
  readonly name: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #connectionFactory: RealtimeConnectionFactory;
  readonly #transcriptListeners = new Set<(delta: RealtimeTranscriptDelta) => void>();
  readonly #audioListeners = new Set<(audio: RenderedSpeech) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  #connection: RealtimeConnection | undefined;
  #session?: ServiceSession;
  #channel?: ChannelConfig;
  #audioSequence = 0;

  constructor(
    apiKey: string,
    model: string,
    options: { connectionFactory?: RealtimeConnectionFactory } = {},
  ) {
    this.#apiKey = apiKey;
    this.#model = model;
    this.name = `openai-realtime-translate:${model}`;
    this.#connectionFactory = options.connectionFactory ?? createWebSocketRealtimeConnection;
  }

  async start(session: ServiceSession, channel: ChannelConfig): Promise<void> {
    if (this.#connection) throw new Error('Realtime translation channel is already running.');
    if (channel.voiceMode === 'source') throw new Error('Source channels do not use translation.');
    if (channel.translationProvider !== 'openai-realtime') {
      throw new Error('Channel is not configured for OpenAI Realtime translation.');
    }
    this.#session = session;
    this.#channel = channel;
    this.#audioSequence = 0;
    const connection = this.#connectionFactory({
      url: `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(this.#model)}`,
      bearerToken: this.#apiKey,
      safetyIdentifier: `multilinguum-${session.id}`,
    });
    connection.onEvent((event) => this.#receive(event));
    this.#connection = connection;
    await connection.open();
    const updated = connection.waitFor('session.updated');
    connection.send({
      type: 'session.update',
      session: { audio: { output: { language: channel.targetLanguage } } },
    });
    await updated;
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    if (!this.#connection) throw new Error('Realtime translation channel is not running.');
    if (chunk.encoding !== 'pcm_s16le') throw new Error('Realtime translation requires PCM audio.');
    const data =
      chunk.sampleRate === 48_000
        ? downsamplePcm48kTo24k(chunk.data)
        : chunk.sampleRate === 24_000
          ? chunk.data
          : undefined;
    if (!data) throw new Error('Realtime translation supports only 24 kHz or 48 kHz mono PCM.');
    this.#connection.send({
      type: 'session.input_audio_buffer.append',
      audio: Buffer.from(data).toString('base64'),
    });
  }

  async stop(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (!connection) return;
    const closed = connection.waitFor('session.closed', 45_000);
    connection.send({ type: 'session.close' });
    await closed;
    connection.close();
  }

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

  #receive(event: RealtimeEvent): void {
    if (event.type === 'error') {
      const detail = event.error as { message?: unknown } | undefined;
      const error = new Error(
        typeof detail?.message === 'string'
          ? detail.message
          : 'OpenAI Realtime translation failed.',
      );
      for (const listener of this.#errorListeners) listener(error);
      return;
    }
    const session = this.#session;
    const channel = this.#channel;
    if (!session || !channel) return;
    if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
      const delta: RealtimeTranscriptDelta = {
        sessionId: session.id,
        channelId: channel.id,
        language: channel.targetLanguage,
        delta: event.delta,
        receivedAtUnixMs: Date.now(),
        ...(typeof event.elapsed_ms === 'number' ? { sourceElapsedMs: event.elapsed_ms } : {}),
      };
      for (const listener of this.#transcriptListeners) listener(delta);
      return;
    }
    if (event.type !== 'session.output_audio.delta' || typeof event.delta !== 'string') return;
    const sampleRate = typeof event.sample_rate === 'number' ? event.sample_rate : 24_000;
    const raw = new Uint8Array(Buffer.from(event.delta, 'base64'));
    const data = sampleRate === 24_000 ? upsamplePcm24kTo48k(raw) : raw;
    if (sampleRate !== 24_000 && sampleRate !== 48_000) {
      for (const listener of this.#errorListeners) {
        listener(new Error(`Unsupported Realtime output sample rate: ${sampleRate}.`));
      }
      return;
    }
    const durationMs = Math.round((data.byteLength / 2 / 48_000) * 1_000);
    const startMs =
      typeof event.elapsed_ms === 'number' ? Math.max(0, Math.round(event.elapsed_ms)) : 0;
    const audio: RenderedSpeech = {
      data,
      encoding: 'pcm_s16le',
      sampleRate: 48_000,
      startMs,
      endMs: startMs + Math.max(1, durationMs),
      sequence: this.#audioSequence++,
      language: channel.targetLanguage,
      renderer: this.name,
    };
    for (const listener of this.#audioListeners) listener(audio);
  }
}
