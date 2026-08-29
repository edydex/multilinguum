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
}

export class LiveKitMediaRelay implements MediaRelay {
  readonly name = 'livekit-cloud';
  readonly #url: string;
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #broadcast: (event: ProcessorEvent) => void;
  readonly #channels = new Map<string, PublishedAudio>();
  readonly #listenerLanguages = new Map<string, Language>();
  readonly #listenerCountListeners = new Set<(language: Language, count: number) => void>();
  #room: Room | undefined;
  #session: ServiceSession | undefined;

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
    await room.connect(this.#url, await token.toJwt(), {
      autoSubscribe: false,
      dynacast: false,
    });
    for (const participant of room.remoteParticipants.values()) trackListener(participant);
    this.#room = room;
  }

  async publishChannel(config: ChannelConfig): Promise<PublishedChannel> {
    const room = this.#room;
    const session = this.#session;
    if (!room || !session?.relayRoom) throw new Error('LiveKit relay is not connected.');
    const existing = this.#channels.get(config.id);
    if (existing) {
      return { channelId: config.id, roomName: session.relayRoom, trackName: existing.trackName };
    }
    // Give the look-ahead renderer room to queue several clauses. The source
    // still plays at real-time speed; this prevents API/render jitter from
    // becoming an audible pause between every sentence.
    const source = new AudioSource(48000, 1, 45_000);
    const trackName =
      config.voiceMode === 'source'
        ? `source-${config.targetLanguage}`
        : `translation-${config.targetLanguage}`;
    const track = LocalAudioTrack.createAudioTrack(trackName, source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    const participant = room.localParticipant;
    if (!participant) throw new Error('LiveKit local participant is unavailable.');
    await participant.publishTrack(track, options);
    this.#channels.set(config.id, { source, track, trackName });
    return { channelId: config.id, roomName: session.relayRoom, trackName };
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
    for (let offset = 0; offset < samples.length; offset += frameSamples) {
      const frameData = samples.slice(offset, Math.min(offset + frameSamples, samples.length));
      if (frameData.length === 0) continue;
      await published.source.captureFrame(new AudioFrame(frameData, 48000, 1, frameData.length));
    }
  }

  audioBacklogMs(channelId: string): number {
    return Math.max(0, Math.round(this.#channels.get(channelId)?.source.queuedDuration ?? 0));
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
