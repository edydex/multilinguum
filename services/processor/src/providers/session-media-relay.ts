import type {
  ChannelConfig,
  Language,
  MediaRelay,
  RenderedSpeech,
  ServiceSession,
  TranscriptSegment,
} from '@multilinguum/protocol';

/** Direct output-clock audio needs WebRTC; source-timed speech uses buffered HTTP. */
export function usesRealtimeRelay(session: ServiceSession): boolean {
  return session.targets.some((channel) => channel.translationProvider === 'openai-realtime');
}

/** Choose once per service so stored optional relay settings cannot block buffered audio. */
export class SessionMediaRelay implements MediaRelay {
  readonly #select: (session: ServiceSession) => MediaRelay;
  readonly #listeners = new Set<(language: Language, count: number) => void>();
  #delegate: MediaRelay | undefined;
  #sessionId: string | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(select: (session: ServiceSession) => MediaRelay) {
    this.#select = select;
  }

  get name(): string {
    return this.#delegate?.name ?? 'session-media-relay';
  }

  onListenerCount(listener: (language: Language, count: number) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async createSession(session: ServiceSession): Promise<void> {
    if (this.#delegate) throw new Error('Media relay session is already active.');
    const delegate = this.#select(session);
    this.#delegate = delegate;
    this.#sessionId = session.id;
    this.#unsubscribe = delegate.onListenerCount((language, count) => {
      if (this.#delegate !== delegate) return;
      for (const listener of this.#listeners) listener(language, count);
    });
    try {
      await delegate.createSession(session);
    } catch (error) {
      try {
        await this.closeSession(session.id);
      } catch {
        /* Preserve the startup error. */
      }
      throw error;
    }
  }

  publishChannel(config: ChannelConfig) {
    return this.#required().publishChannel(config);
  }

  publishAudio(channelId: string, chunk: RenderedSpeech): Promise<void> {
    return this.#required().publishAudio(channelId, chunk);
  }

  publishCaption(segment: TranscriptSegment): Promise<void> {
    return this.#required().publishCaption(segment);
  }

  audioBacklogMs(channelId: string): number {
    return this.#delegate?.audioBacklogMs(channelId) ?? 0;
  }

  clearAudio(channelId: string): void {
    this.#delegate?.clearAudio(channelId);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (sessionId !== this.#sessionId) return;
    try {
      await this.#delegate?.closeSession(sessionId);
    } finally {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#delegate = undefined;
      this.#sessionId = undefined;
    }
  }

  #required(): MediaRelay {
    if (!this.#delegate) throw new Error('Media relay session has not started.');
    return this.#delegate;
  }
}
