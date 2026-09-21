import WebSocket from 'ws';
import type {
  AudioChunk,
  ServiceSession,
  TranscriptSegment,
  Transcriber,
} from '@multilinguum/protocol';
import { downsamplePcm48kTo24k } from './realtime-transport.js';

export const MUSE_TRANSCRIPTION_MODEL = 'muse-voice-transcribe-1.0';
type Event = Record<string, unknown>;
type Turn = {
  sequence: number;
  startMs: number;
  endMs?: number;
  firstDeltaAtUnixMs?: number;
  revision: number;
  timer: ReturnType<typeof setTimeout>;
};
export type MuseSocket = Pick<
  WebSocket,
  'on' | 'once' | 'off' | 'send' | 'close' | 'terminate' | 'readyState' | 'bufferedAmount'
>;
interface MuseOptions {
  socketFactory?: () => MuseSocket;
  keywords?: (session: ServiceSession) => Promise<string[]>;
  drainMs?: number;
  handshakeMs?: number;
  turnTimeoutMs?: number;
  rotateAfterMs?: number;
  pace?: boolean;
}

/** Muse authenticates in the first JSON frame, then accepts binary mono PCM, not base64 JSON. */
export class MuseLiveTranscriber implements Transcriber {
  readonly name = `muse-live-transcribe:${MUSE_TRANSCRIPTION_MODEL}`;
  readonly #apiKey: string;
  readonly #options: MuseOptions;
  readonly #listeners = new Set<(segment: TranscriptSegment) => void>();
  readonly #errors = new Set<(error: Error) => void>();
  readonly #turns = new Map<string, Turn>();
  readonly #completed = new Map<number, TranscriptSegment | null>();
  readonly #seen = new Set<string>();
  #socket: MuseSocket | undefined;
  #session: ServiceSession | undefined;
  #keywords: string[] = [];
  #sequence = 0;
  #nextFinal = 0;
  #latestTurn: string | undefined;
  #epoch = 0;
  #epochStartMs: number | undefined;
  #audioMs = 0;
  #wallStart = 0;
  #draining = false;
  #ready = false;
  #closed: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;
  #failure: Error | undefined;

  constructor(apiKey: string, options: MuseOptions = {}) {
    this.#apiKey = apiKey;
    this.#options = options;
  }

  async start(session: ServiceSession): Promise<void> {
    if (this.#session) throw new Error('Muse transcription is already running.');
    if (session.sourceLanguage !== 'en')
      throw new Error('Muse does not support Russian transcription. Choose OpenAI for Russian.');
    this.#session = session;
    this.#sequence = 0;
    this.#nextFinal = 0;
    this.#epoch = 0;
    this.#completed.clear();
    this.#seen.clear();
    this.#failure = undefined;
    try {
      this.#keywords = ((await this.#options.keywords?.(session)) ?? [])
        .slice(0, 64)
        .map((value) => value.slice(0, 60));
      await this.#connect();
    } catch (error) {
      this.#socket?.terminate();
      this.#socket = undefined;
      this.#session = undefined;
      throw error;
    }
  }

  async #connect(): Promise<void> {
    this.#draining = false;
    this.#ready = false;
    this.#audioMs = 0;
    this.#epochStartMs = undefined;
    this.#latestTurn = undefined;
    this.#epoch += 1;
    const socket =
      this.#options.socketFactory?.() ??
      new WebSocket('wss://api.meta.ai/v1/asr/realtime', {
        handshakeTimeout: 15_000,
        maxPayload: 1_048_576,
      });
    this.#socket = socket;
    this.#closed = new Promise((resolve) => {
      this.#finishClose = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () =>
          fail('Muse did not acknowledge the connection. Check the API token and connectivity.'),
        this.#options.handshakeMs ?? 15_000,
      );
      const fail = (message: string) => {
        const error = new Error(message);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        } else this.#report(error);
        this.#failure = error;
      };
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            authorization: { accessToken: `Bearer ${this.#apiKey}` },
            model: MUSE_TRANSCRIPTION_MODEL,
            audioEncoding: 'PCM_24KHZ',
            mode: 'ENDPOINTING',
            partialMode: 'CUMULATIVE',
            emitAudioProgress: true,
            languageBias: ['English'],
            keywords: this.#keywords,
          }),
        );
      });
      socket.on('message', (data) => {
        if (this.#socket !== socket) return;
        let event: Event;
        try {
          event = JSON.parse(data.toString()) as Event;
        } catch {
          fail('Muse sent an unreadable recognition response.');
          return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          fail('Muse sent an invalid recognition response.');
          return;
        }
        if (event.type === 'error') {
          // Provider errors may echo requests. Never expose the handshake, token, or private notes.
          fail('Muse transcription failed. Check API access, quota, and the source language.');
          return;
        }
        if (!settled && typeof event.sessionId === 'string' && !event.type) {
          settled = true;
          clearTimeout(timer);
          this.#ready = true;
          resolve();
          return;
        }
        if (this.#ready) this.#receive(event);
      });
      socket.on('error', () => fail('The secure connection to Muse failed.'));
      socket.on('close', (code) => {
        this.#ready = false;
        if (!this.#draining || code !== 1000)
          fail('Muse disconnected before recognition finished. Reconnect capture to continue.');
        else if (!settled) fail('Muse closed before acknowledging the session.');
        this.#finishClose?.();
      });
    });
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    if (!this.#session || !this.#ready || this.#failure)
      throw this.#failure ?? new Error('Muse transcription is not ready.');
    if (chunk.encoding !== 'pcm_s16le' || chunk.data.byteLength % 2 !== 0)
      throw new Error('Muse requires complete mono PCM16 samples.');
    const data =
      chunk.sampleRate === 48_000
        ? downsamplePcm48kTo24k(chunk.data)
        : chunk.sampleRate === 24_000
          ? chunk.data
          : undefined;
    if (!data) throw new Error('Muse capture requires 24 kHz or 48 kHz mono PCM.');
    if (data.byteLength > 240_000)
      throw new Error('Muse audio frames must not exceed five seconds.');
    if (!data.byteLength) return;
    if (this.#audioMs >= (this.#options.rotateAfterMs ?? 55 * 60_000)) {
      await this.#drain();
      if (this.#failure) throw this.#failure;
      await this.#connect();
    }
    if (this.#epochStartMs === undefined) {
      this.#epochStartMs = chunk.startMs;
      this.#wallStart = performance.now();
    }
    const wait = this.#audioMs - (performance.now() - this.#wallStart) - 200;
    if (this.#options.pace !== false && wait > 0)
      await new Promise((resolve) => setTimeout(resolve, wait));
    const socket = this.#socket!;
    if (socket.bufferedAmount > 240_000)
      throw new Error('Muse cannot keep up with the incoming audio. Check the connection.');
    await new Promise<void>((resolve, reject) =>
      socket.send(data, (error) =>
        error ? reject(new Error('Audio could not be sent to Muse.')) : resolve(),
      ),
    );
    this.#audioMs += data.byteLength / 48;
  }

  // ENDPOINTING detects pauses itself. A client commit would incorrectly end the stream.
  flushAudio(): void {}

  async stop(): Promise<void> {
    if (!this.#session) return;
    try {
      await this.#drain();
    } finally {
      this.#session = undefined;
      this.#socket = undefined;
      this.#ready = false;
    }
  }

  async #drain(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    this.#draining = true;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'endStream' }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#closed,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          this.#failure = new Error('Muse did not finish the final audio before the stop timeout.');
          this.#report(this.#failure);
          socket.terminate();
          resolve();
        }, this.#options.drainMs ?? 15_000);
      }),
    ]);
    clearTimeout(timeout);
    for (const [id, turn] of this.#turns) {
      this.#report(new Error('A Muse speech turn ended without a final transcript.'));
      this.#complete(id, turn, null);
    }
    this.#ready = false;
  }

  #receive(event: Event): void {
    const key =
      typeof event.turnId === 'string' || typeof event.turnId === 'number'
        ? `${this.#epoch}:${event.turnId}`
        : undefined;
    const position =
      typeof event.audioProcessedMs === 'number' && Number.isFinite(event.audioProcessedMs)
        ? Math.max(0, event.audioProcessedMs) + (this.#epochStartMs ?? 0)
        : undefined;
    if (
      event.type === 'speechStart' &&
      key &&
      position !== undefined &&
      !this.#turns.has(key) &&
      !this.#seen.has(key)
    ) {
      const turn: Turn = {
        sequence: this.#sequence++,
        startMs: position,
        revision: 0,
        timer: setTimeout(() => {
          this.#report(
            new Error('A Muse speech turn did not finish within the recognition timeout.'),
          );
          this.#complete(key, turn, null);
        }, this.#options.turnTimeoutMs ?? 120_000),
      };
      this.#turns.set(key, turn);
      this.#latestTurn = key;
      return;
    }
    if (event.type === 'speechEnd' && key && position !== undefined) {
      const turn = this.#turns.get(key);
      if (turn) turn.endMs = Math.max(turn.startMs + 1, position);
      return;
    }
    const partial = event.type === 'transcript';
    const id = partial ? this.#latestTurn : key;
    const turn = id ? this.#turns.get(id) : undefined;
    if (
      (!partial && event.type !== 'speechComplete') ||
      !id ||
      !turn ||
      typeof event.transcript !== 'string' ||
      !this.#session
    )
      return;
    const text = event.transcript.trim();
    if (partial && !text) return;
    turn.firstDeltaAtUnixMs ??= Date.now();
    turn.revision += 1;
    const segment: TranscriptSegment = {
      id: `${this.#session.id}:muse:${id}`,
      sessionId: this.#session.id,
      channelId: 'source-en',
      language: 'en',
      text,
      sourceStartMs: Math.round(turn.startMs),
      sourceEndMs: Math.round(
        Math.max(turn.startMs + 1, turn.endMs ?? position ?? turn.startMs + 1),
      ),
      emittedAt: new Date().toISOString(),
      firstDeltaAtUnixMs: turn.firstDeltaAtUnixMs,
      revision: turn.revision,
      final: !partial,
      sequence: turn.sequence,
      ...(partial ? { phase: 'transcribing' as const } : {}),
    };
    if (partial) for (const listener of this.#listeners) listener(segment);
    else this.#complete(id, turn, text ? segment : null);
  }

  #complete(id: string, turn: Turn, segment: TranscriptSegment | null): void {
    clearTimeout(turn.timer);
    this.#turns.delete(id);
    this.#seen.add(id);
    if (this.#seen.size > 2_048) this.#seen.delete(this.#seen.values().next().value!);
    this.#completed.set(turn.sequence, segment);
    while (this.#completed.has(this.#nextFinal)) {
      const next = this.#completed.get(this.#nextFinal);
      this.#completed.delete(this.#nextFinal++);
      if (next) for (const listener of this.#listeners) listener(next);
    }
  }

  onSegment(listener: (segment: TranscriptSegment) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.#errors.add(listener);
    return () => this.#errors.delete(listener);
  }
  #report(error: Error): void {
    for (const listener of this.#errors) listener(error);
  }
}
