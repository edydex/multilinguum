import { randomUUID } from 'node:crypto';
import type {
  BufferedAudioClip,
  ChannelConfig,
  Language,
  MediaRelay,
  PublishedChannel,
  RenderedSpeech,
  ServiceSession,
  TranscriptSegment,
} from '@multilinguum/protocol';

interface StoredClip {
  metadata: BufferedAudioClip;
  wave: Buffer;
}

/** A short, memory-bounded live window, independent of the retained sermon archive. */
export class BufferedAudioRelay implements MediaRelay {
  readonly #delegate: MediaRelay;
  readonly #publish: (clip: BufferedAudioClip) => void;
  readonly #clear: (sessionId: string, channelId: string, generation: number) => void;
  readonly #now: () => number;
  readonly #maximumBytes: number;
  readonly #retentionMs: number;
  readonly #clips = new Map<string, StoredClip>();
  readonly #channels = new Map<string, ChannelConfig>();
  readonly #generations = new Map<string, number>();
  #session: ServiceSession | undefined;
  #bytes = 0;

  constructor(
    delegate: MediaRelay,
    publish: (clip: BufferedAudioClip) => void,
    clear: (sessionId: string, channelId: string, generation: number) => void,
    options: { now?: () => number; maximumBytes?: number; retentionMs?: number } = {},
  ) {
    this.#delegate = delegate;
    this.#publish = publish;
    this.#clear = clear;
    this.#now = options.now ?? Date.now;
    this.#maximumBytes = options.maximumBytes ?? 64 * 1024 * 1024;
    this.#retentionMs = options.retentionMs ?? 240_000;
  }

  get name(): string {
    return `${this.#delegate.name}+buffered-audio`;
  }

  onListenerCount(listener: (language: Language, count: number) => void) {
    return this.#delegate.onListenerCount(listener);
  }

  async createSession(session: ServiceSession): Promise<void> {
    this.#reset();
    await this.#delegate.createSession(session);
    this.#session = session;
  }

  async publishChannel(config: ChannelConfig): Promise<PublishedChannel> {
    this.#channels.set(config.id, { ...config });
    return this.#delegate.publishChannel(config);
  }

  audioBacklogMs(channelId: string): number {
    return this.#delegate.audioBacklogMs(channelId);
  }

  generation(channelId: string): number {
    return this.#generations.get(channelId) ?? 0;
  }

  clearAudio(channelId: string): void {
    const generation = this.generation(channelId) + 1;
    this.#generations.set(channelId, generation);
    for (const [id, clip] of this.#clips) {
      if (clip.metadata.channelId === channelId) this.#remove(id);
    }
    if (this.#session) this.#clear(this.#session.id, channelId, generation);
    this.#delegate.clearAudio(channelId);
  }

  async publishCaption(segment: TranscriptSegment): Promise<void> {
    await this.#delegate.publishCaption(segment);
  }

  async publishAudio(channelId: string, chunk: RenderedSpeech): Promise<void> {
    const clip = this.#append(channelId, chunk);
    if (clip) this.#publish(clip);
    // Browser delivery uses the existing rendered bytes, independently of how
    // long the optional real-time relay needs to enqueue them.
    await this.#delegate.publishAudio(channelId, chunk);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (this.#session?.id === sessionId) {
      for (const channelId of this.#channels.keys()) this.clearAudio(channelId);
      this.#reset();
    }
    await this.#delegate.closeSession(sessionId);
  }

  snapshot(sessionId: string): BufferedAudioClip[] {
    this.#prune();
    if (this.#session?.id !== sessionId) return [];
    return [...this.#clips.values()].map((clip) => ({ ...clip.metadata }));
  }

  read(sessionId: string, clipId: string): StoredClip | undefined {
    this.#prune();
    if (this.#session?.id !== sessionId) return undefined;
    const clip = this.#clips.get(clipId);
    return clip ? { metadata: { ...clip.metadata }, wave: clip.wave } : undefined;
  }

  #append(channelId: string, chunk: RenderedSpeech): BufferedAudioClip | undefined {
    const session = this.#session;
    const channel = this.#channels.get(channelId);
    const startedAt = Date.parse(session?.startedAt ?? '');
    if (!session || !channel) return;
    if (chunk.encoding !== 'pcm_s16le' || !chunk.data.byteLength) return;
    if (!Number.isFinite(startedAt) || !Number.isFinite(chunk.startMs) || chunk.startMs < 0) return;
    if (!Number.isFinite(chunk.endMs) || chunk.endMs < chunk.startMs) return;
    if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0) return;
    if (
      !Number.isSafeInteger(chunk.sampleRate) ||
      chunk.sampleRate < 8_000 ||
      chunk.sampleRate > 96_000
    )
      return;
    if (
      chunk.sourceStartAtUnixMs !== undefined &&
      (!Number.isFinite(chunk.sourceStartAtUnixMs) ||
        !Number.isFinite(chunk.sourceEndAtUnixMs) ||
        chunk.sourceEndAtUnixMs! < chunk.sourceStartAtUnixMs)
    )
      return;
    if (chunk.data.byteLength % 2 !== 0 || chunk.language !== channel.targetLanguage) return;
    const durationMs = (chunk.data.byteLength / 2 / chunk.sampleRate) * 1_000;
    if (durationMs > 120_000 || chunk.data.byteLength + 44 > this.#maximumBytes) return;
    const wave = Buffer.allocUnsafe(chunk.data.byteLength + 44);
    wave.write('RIFF', 0);
    wave.writeUInt32LE(wave.length - 8, 4);
    wave.write('WAVEfmt ', 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(chunk.sampleRate, 24);
    wave.writeUInt32LE(chunk.sampleRate * 2, 28);
    wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write('data', 36);
    wave.writeUInt32LE(chunk.data.byteLength, 40);
    wave.set(chunk.data, 44);
    const metadata: BufferedAudioClip = {
      id: randomUUID(),
      sessionId: session.id,
      channelId,
      language: channel.targetLanguage,
      generation: this.generation(channelId),
      ...(channel.translationProvider === 'openai-realtime'
        ? { timingBasis: 'output' as const }
        : {}),
      sequence: chunk.sequence,
      sourceStartAtUnixMs: chunk.sourceStartAtUnixMs ?? startedAt + chunk.startMs,
      sourceEndAtUnixMs: chunk.sourceEndAtUnixMs ?? startedAt + chunk.endMs,
      publishedAtUnixMs: this.#now(),
      durationMs,
      byteLength: wave.length,
    };
    this.#clips.set(metadata.id, { metadata, wave });
    this.#bytes += wave.length;
    this.#prune();
    return this.#clips.has(metadata.id) ? { ...metadata } : undefined;
  }

  #remove(id: string): void {
    const clip = this.#clips.get(id);
    if (!clip) return;
    this.#bytes -= clip.wave.length;
    this.#clips.delete(id);
  }

  #prune(): void {
    const earliest = this.#now() - this.#retentionMs;
    for (const [id, clip] of this.#clips) {
      if (
        clip.metadata.publishedAtUnixMs < earliest ||
        this.#bytes > this.#maximumBytes ||
        this.#clips.size > 512
      )
        this.#remove(id);
    }
  }

  #reset(): void {
    this.#session = undefined;
    this.#clips.clear();
    this.#channels.clear();
    this.#generations.clear();
    this.#bytes = 0;
  }
}
