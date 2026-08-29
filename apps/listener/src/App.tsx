import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteAudioTrack, Room } from 'livekit-client';
import type {
  Language,
  ProcessorEvent,
  PublicServiceState,
  TranscriptSegment,
} from '@multilinguum/protocol';

const names: Record<Language, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  uk: 'Українська',
};

const apiBase = import.meta.env.VITE_PROCESSOR_PUBLIC_URL ?? window.location.origin;

interface TokenResponse {
  url: string;
  token: string;
  expiresInSeconds: number;
}

interface CaptionPair {
  final?: TranscriptSegment;
  live?: TranscriptSegment;
}

function mergeCaption(current: CaptionPair | undefined, segment: TranscriptSegment): CaptionPair {
  const existing = current ?? {};
  if (!segment.final) {
    if ((existing.final?.sequence ?? -1) > segment.sequence) return existing;
    if ((existing.live?.sequence ?? -1) > segment.sequence) return existing;
    return { ...existing, live: segment };
  }
  if ((existing.final?.sequence ?? -1) > segment.sequence) return existing;
  return {
    final: segment,
    ...(existing.live && existing.live.sequence > segment.sequence ? { live: existing.live } : {}),
  };
}

export function App() {
  const [service, setService] = useState<PublicServiceState>({
    active: false,
    churchName: 'Word of Truth',
    languages: [],
  });
  const [language, setLanguage] = useState<Language>();
  const [captions, setCaptions] = useState<Record<string, CaptionPair>>({});
  const [connected, setConnected] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState<string>();
  const roomRef = useRef<Room | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const tracksRef = useRef(new Map<Language, RemoteAudioTrack>());

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch(new URL('/api/public/service', apiBase));
        const next = (await response.json()) as PublicServiceState;
        setService(next);
        setLanguage(
          (current) => current ?? next.languages.find((item) => item.available)?.language,
        );
      } catch {
        setService((current) => ({ ...current, active: false }));
      }
    };
    void load();
    let stopped = false;
    let retryDelayMs = 1_000;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;
    const connectEvents = () => {
      const url = new URL('/api/public/events', apiBase);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => {
        retryDelayMs = 1_000;
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as
          ProcessorEvent | { type: 'public-state'; state: PublicServiceState };
        if (event.type === 'public-state') {
          setService(event.state);
        } else if (event.type === 'session') {
          void load();
        } else if (event.type === 'transcript') {
          setCaptions((current) => ({
            ...current,
            [event.segment.language]: mergeCaption(current[event.segment.language], event.segment),
          }));
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        retryTimer = window.setTimeout(connectEvents, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 15_000);
      };
    };
    connectEvents();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!language || !connected) return;
    void roomRef.current?.localParticipant
      .setMetadata(JSON.stringify({ role: 'anonymous-listener', language }))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    const track = tracksRef.current.get(language);
    if (!track) return;
    audioRef.current?.remove();
    const audio = track.attach();
    audio.autoplay = true;
    audio.controls = false;
    audio.volume = volume;
    document.body.append(audio);
    audioRef.current = audio;
    void audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false));
  }, [connected, language, volume]);

  const beginListening = async () => {
    if (!language) return;
    if (playing && audioRef.current) {
      audioRef.current.pause();
      setPlaying(false);
      return;
    }
    if (connected && audioRef.current) {
      await audioRef.current.play();
      setPlaying(true);
      return;
    }
    setError(undefined);
    try {
      const { Room: LiveKitRoom, RoomEvent } = await import('livekit-client');
      const tokenUrl = new URL('/api/public/token', apiBase);
      tokenUrl.searchParams.set('language', language);
      const response = await fetch(tokenUrl);
      if (!response.ok) throw new Error('The audio stream is not ready yet.');
      const credentials = (await response.json()) as TokenResponse;
      const room = new LiveKitRoom({ adaptiveStream: true, dynacast: false });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track, publication) => {
        if (track.kind !== 'audio') return;
        const match = publication.trackName.match(/(?:translation|source)-([a-z]{2})$/);
        if (!match) return;
        tracksRef.current.set(match[1] as Language, track as RemoteAudioTrack);
        if (match[1] === language) {
          const audio = track.attach();
          audio.volume = volume;
          document.body.append(audio);
          audioRef.current = audio;
          void audio.play().then(() => setPlaying(true));
        }
      });
      room.on(RoomEvent.Reconnecting, () => setConnected(false));
      room.on(RoomEvent.Reconnected, () => setConnected(true));
      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
        setPlaying(false);
      });
      await room.connect(credentials.url, credentials.token, { autoSubscribe: true });
      await room.startAudio();
      setConnected(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(
    () => () => {
      roomRef.current?.disconnect();
      audioRef.current?.remove();
    },
    [],
  );

  const selectedChannel = service.languages.find((item) => item.language === language);
  const caption = language ? captions[language] : undefined;
  const status = useMemo(() => {
    if (!service.active) return 'Service offline';
    if (!connected) return 'Ready to connect';
    return playing ? 'Listening live' : 'Paused';
  }, [connected, playing, service.active]);

  return (
    <main>
      <div className="topline">
        <span className={service.active ? 'live-dot' : ''} />
        {status}
      </div>
      <header>
        <div className="church-mark">✦</div>
        <p>{service.churchName}</p>
        <h1>Live translation</h1>
        <span className="delay">Approximately 5–20 seconds behind, depending on voice mode</span>
      </header>

      {!service.active ? (
        <section className="offline-card">
          <div>◌</div>
          <h2>No service is live</h2>
          <p>Leave this page open. It will update when translation begins.</p>
        </section>
      ) : (
        <>
          <section className="language-picker" aria-label="Translation language">
            {service.languages.map((item) => (
              <button
                key={item.language}
                disabled={!item.available}
                className={language === item.language ? 'selected' : ''}
                onClick={() => setLanguage(item.language)}
              >
                <strong>{item.language.toUpperCase()}</strong>
                <span>{names[item.language]}</span>
              </button>
            ))}
          </section>

          <section className="player">
            <div className="wave" aria-hidden="true">
              {[12, 24, 34, 19, 40, 28, 15, 36, 25, 13, 30, 20].map((height, index) => (
                <i key={index} style={{ height }} />
              ))}
            </div>
            <button className="listen" disabled={!language} onClick={() => void beginListening()}>
              {playing ? '❚❚  Pause' : '▶  Listen'}
            </button>
            <label className="volume">
              Volume
              <input
                aria-label="Volume"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
            <div className={`stream-status ${connected ? 'connected' : ''}`}>
              <i />
              {connected ? 'Secure stream connected' : 'Tap Listen to connect'}
            </div>
          </section>

          <section className={`captions ${captionsVisible ? '' : 'hidden'}`}>
            <div className="caption-title">
              <span>LIVE CAPTIONS</span>
              <button onClick={() => setCaptionsVisible((visible) => !visible)}>
                {captionsVisible ? 'Hide' : 'Show'}
              </button>
            </div>
            {captionsVisible && (
              <p className="caption-copy">
                {caption?.final ? (
                  <span className="caption-final">{caption.final.text}</span>
                ) : !caption?.live ? (
                  <span className="caption-placeholder">
                    Captions will appear when the speaker begins.
                  </span>
                ) : null}
                {caption?.live &&
                  (!caption.final || caption.live.sequence > caption.final.sequence) && (
                    <span className="caption-live">{caption.live.text}</span>
                  )}
              </p>
            )}
          </section>

          <p className="disclosure">
            {selectedChannel?.disclosure ?? 'AI-generated translated voice'}. Translation may
            contain errors; consult the original service for authoritative wording.
          </p>
        </>
      )}
      {error && <div className="error">{error}</div>}
      <footer>Multilinguum · No account or sign-in required</footer>
    </main>
  );
}
