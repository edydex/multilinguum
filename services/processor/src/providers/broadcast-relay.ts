import type {
  ChannelConfig,
  Language,
  MediaRelay,
  ProcessorEvent,
  PublishedChannel,
  RenderedSpeech,
  ServiceSession,
  TranscriptSegment,
} from '@multilinguum/protocol';

export type EventBroadcaster = (event: ProcessorEvent) => void;

export class BroadcastMediaRelay implements MediaRelay {
  readonly name = 'broadcast-control-relay';
  readonly #broadcast: EventBroadcaster;
  #session: ServiceSession | undefined;

  constructor(broadcast: EventBroadcaster) {
    this.#broadcast = broadcast;
  }

  onListenerCount(_listener: (language: Language, count: number) => void): () => void {
    return () => undefined;
  }

  async createSession(session: ServiceSession): Promise<void> {
    this.#session = session;
  }

  async publishChannel(config: ChannelConfig): Promise<PublishedChannel> {
    if (!this.#session) {
      throw new Error('Relay session has not started.');
    }
    return {
      channelId: config.id,
      roomName: this.#session.relayRoom ?? `service-${this.#session.id}`,
      trackName: `translation-${config.targetLanguage}`,
    };
  }

  async publishAudio(_channelId: string, _chunk: RenderedSpeech): Promise<void> {
    // BufferedAudioRelay delivers cascade speech over HTTP without a LiveKit connection.
    // Direct Realtime audio uses the separately configured LiveKit publisher.
  }

  audioBacklogMs(_channelId: string): number {
    return 0;
  }

  clearAudio(_channelId: string): void {}

  async publishCaption(segment: TranscriptSegment): Promise<void> {
    this.#broadcast({ type: 'transcript', segment });
  }

  async closeSession(_sessionId: string): Promise<void> {
    this.#session = undefined;
  }
}
