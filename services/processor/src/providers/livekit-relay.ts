import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  type Participant,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
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

interface PublishedAudio {
  source: AudioSource;
  track: LocalAudioTrack;
  trackName: string;
  generation: number;
}

export class LiveKitMediaRelay implements MediaRelay {
  readonly name = 'livekit-cloud';
  readonly #url: string;
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #broadcast: (event: ProcessorEvent) => void;
  readonly #channels = new Map<string, PublishedAudio>();
  readonly #publishing = new Map<string, Promise<PublishedChannel>>();
  readonly #listenerLanguages = new Map<string, Language>();
  readonly #listenerCountListeners = new Set<(language: Language, count: number) => void>();
  #room: Room | undefined;
  #session: ServiceSession | undefined;
  #connecting: Promise<void> | undefined;

  constructor(
    url: string,
    apiKey: string,
    apiSecret: string,
    broadcast: (event: ProcessorEvent) => void,
  ) {
    this.#url = url;
    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#broadcast = broadcast;
  }

  onListenerCount(listener: (language: Language, count: number) => void): () => void {
    this.#listenerCountListeners.add(listener);
    return () => this.#listenerCountListeners.delete(listener);
  }

  async createSession(session: ServiceSession): Promise<void> {
    if (!session.relayRoom) throw new Error('Session has no LiveKit room name.');
    this.#session = session;
    // Caption-only sessions need no LiveKit connection, even when credentials are configured.
  }

  async #connect(): Promise<void> {
    if (this.#room) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#openRoom();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #openRoom(): Promise<void> {
    const session = this.#session;
    if (!session?.relayRoom) throw new Error('Session has no LiveKit room name.');
    const token = new AccessToken(this.#apiKey, this.#apiSecret, {
      identity: `processor-${session.id}`,
      name: 'Multilinguum processor',
      ttl: '3h',
    });
    token.addGrant({
      room: session.relayRoom,
      roomJoin: true,
      roomCreate: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: false,
    });
    const room = new Room();
    const trackListener = (participant: Participant) => {
      const language = this.#listenerLanguage(participant.metadata);
      if (language) this.#listenerLanguages.set(participant.identity, language);
      else this.#listenerLanguages.delete(participant.identity);
      this.#notifyListenerCounts();
    };
    room.on(RoomEvent.ParticipantConnected, trackListener);
    room.on(RoomEvent.ParticipantMetadataChanged, (_metadata, participant) =>
      trackListener(participant),
    );
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.#listenerLanguages.delete(participant.identity);
      this.#notifyListenerCounts();
    });
    try {
      await room.connect(this.#url, await token.toJwt(), {
        autoSubscribe: false,
        dynacast: false,
      });
    } catch (error) {
      await room.disconnect();
      throw error;
    }
    for (const participant of room.remoteParticipants.values()) trackListener(participant);
    this.#room = room;
  }

  async publishChannel(config: ChannelConfig): Promise<PublishedChannel> {
    const session = this.#session;
    if (!session?.relayRoom) throw new Error('Relay session has not started.');
    const trackName =
      config.voiceMode === 'source'
        ? `source-${config.targetLanguage}`
        : `translation-${config.targetLanguage}`;
    if (config.speechEnabled === false)
      return { channelId: config.id, roomName: session.relayRoom, trackName };
    const pending = this.#publishing.get(config.id);
    if (pending) return pending;
    const publishing = this.#publishAudioChannel(config, session.relayRoom, trackName);
    this.#publishing.set(config.id, publishing);
    try {
      return await publishing;
    } finally {
      if (this.#publishing.get(config.id) === publishing) this.#publishing.delete(config.id);
    }
  }

  async #publishAudioChannel(
    config: ChannelConfig,
    roomName: string,
    trackName: string,
  ): Promise<PublishedChannel> {
    await this.#connect();
    const room = this.#room;
    if (!room) throw new Error('LiveKit relay is not connected.');
    const existing = this.#channels.get(config.id);
    if (existing) {
      return { channelId: config.id, roomName, trackName: existing.trackName };
    }
    // Give the look-ahead renderer room to queue several clauses. The source
    // still plays at real-time speed; this prevents API/render jitter from
    // becoming an audible pause between every sentence.
    const source = new AudioSource(48000, 1, 45_000);
    const track = LocalAudioTrack.createAudioTrack(trackName, source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    const participant = room.localParticipant;
    if (!participant) throw new Error('LiveKit local participant is unavailable.');
    await participant.publishTrack(track, options);
    this.#channels.set(config.id, { source, track, trackName, generation: 0 });
    return { channelId: config.id, roomName, trackName };
  }

  async publishAudio(channelId: string, chunk: RenderedSpeech): Promise<void> {
    const published = this.#channels.get(channelId);
    if (!published) throw new Error(`LiveKit channel ${channelId} is not published.`);
    if (chunk.encoding !== 'pcm_s16le' || chunk.sampleRate !== 48000) {
      throw new Error('LiveKit publisher requires 48 kHz signed 16-bit mono PCM.');
    }
    const aligned = new Uint8Array(chunk.data.byteLength);
    aligned.set(chunk.data);
    const samples = new Int16Array(aligned.buffer);
    const frameSamples = 480;
    const generation = published.generation;
    for (let offset = 0; offset < samples.length; offset += frameSamples) {
      if (published.generation !== generation) return;
      const frameData = samples.slice(offset, Math.min(offset + frameSamples, samples.length));
      if (frameData.length === 0) continue;
      await published.source.captureFrame(new AudioFrame(frameData, 48000, 1, frameData.length));
    }
  }

  audioBacklogMs(channelId: string): number {
    return Math.max(0, Math.round(this.#channels.get(channelId)?.source.queuedDuration ?? 0));
  }

  clearAudio(channelId: string): void {
    const published = this.#channels.get(channelId);
    if (!published) return;
    published.generation += 1;
    published.source.clearQueue();
  }

  async publishCaption(segment: TranscriptSegment): Promise<void> {
    this.#broadcast({ type: 'transcript', segment });
    const participant = this.#room?.localParticipant;
    if (participant) {
      await participant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: 'transcript', segment })),
        { reliable: true, topic: `captions-${segment.language}` },
      );
    }
  }

  async closeSession(_sessionId: string): Promise<void> {
    await Promise.allSettled(this.#publishing.values());
    for (const published of this.#channels.values()) {
      await published.source.waitForPlayout();
      await published.track.close();
    }
    this.#channels.clear();
    await this.#room?.disconnect();
    this.#room = undefined;
    this.#listenerLanguages.clear();
    this.#notifyListenerCounts();
    this.#session = undefined;
  }

  #listenerLanguage(metadata: string): Language | undefined {
    try {
      const parsed = JSON.parse(metadata) as { role?: unknown; language?: unknown };
      if (
        parsed.role === 'anonymous-listener' &&
        (parsed.language === 'en' ||
          parsed.language === 'ru' ||
          parsed.language === 'es' ||
          parsed.language === 'uk')
      ) {
        return parsed.language;
      }
    } catch {
      // Ignore participants without Multilinguum listener metadata.
    }
    return undefined;
  }

  #notifyListenerCounts(): void {
    const languages = this.#session?.targets.map((channel) => channel.targetLanguage) ?? [];
    for (const language of languages) {
      let count = 0;
      for (const selected of this.#listenerLanguages.values()) {
        if (selected === language) count += 1;
      }
      for (const listener of this.#listenerCountListeners) listener(language, count);
    }
  }
}
