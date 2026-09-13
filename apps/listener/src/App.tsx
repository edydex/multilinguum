import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLiveAudio } from './useLiveAudio';
import type {
  Language,
  ProcessorEvent,
  PublicServiceState,
  TranscriptSegment,
} from '@multilinguum/protocol';
import {
  captionWordState,
  mergeCaption,
  narratedAnchorSequence,
  visibleCaptionSegments,
  type CaptionTimeline,
} from './caption-timeline';

const names: Record<Language, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  uk: 'Українська',
};

const apiBase = import.meta.env.VITE_PROCESSOR_PUBLIC_URL ?? window.location.origin;

function CaptionWords({ segment, now }: { segment: TranscriptSegment; now: number }) {
  const playout = segment.playout;
  if (!playout?.words.length) return <>{segment.text}</>;
  return (
    <>
      {playout.words.map((word, index) => {
        const start = playout.startAtUnixMs + word.startOffsetMs;
        const end = playout.startAtUnixMs + word.endOffsetMs;
        const state = captionWordState(start, end, now);
        return (
          <span
            key={`${segment.sequence}-${index}`}
            className={`caption-word ${state}`}
            aria-current={state === 'current' ? 'true' : undefined}
          >
            {word.text}
            {index < playout.words.length - 1 ? ' ' : ''}
          </span>
        );
      })}
    </>
  );
}

export function App() {
  const [service, setService] = useState<PublicServiceState>({
    active: false,
    serverTimeUnixMs: Date.now(),
    churchName: 'Word of Truth',
    languages: [],
  });
  const [language, setLanguage] = useState<Language>();
  const [captions, setCaptions] = useState<Record<string, CaptionTimeline>>({});
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [volume, setVolume] = useState(1);
  const [followingLive, setFollowingLive] = useState(true);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [captionClock, setCaptionClock] = useState(Date.now());
  const selectedChannel = service.languages.find((item) => item.language === language);
  const audioAvailable = Boolean(
    service.active && selectedChannel?.available && selectedChannel.audioAvailable !== false,
  );
  const {
    connected,
    playing,
    connecting,
    error,
    toggle: beginListening,
  } = useLiveAudio(apiBase, language, audioAvailable, volume);
  const captionViewportRef = useRef<HTMLDivElement | null>(null);
  const captionSegmentRefs = useRef(new Map<number, HTMLElement>());
  const followingLiveRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const load = async () => {
      try {
        const requestedAt = Date.now();
        const response = await fetch(new URL('/api/public/service', apiBase));
        const next = (await response.json()) as PublicServiceState;
        const receivedAt = Date.now();
        setClockOffsetMs(next.serverTimeUnixMs - (requestedAt + receivedAt) / 2);
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
          setClockOffsetMs(event.state.serverTimeUnixMs - Date.now());
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
    if (!service.active || !captionsVisible) return;
    const update = () => setCaptionClock(Date.now() + clockOffsetMs);
    update();
    const timer = window.setInterval(update, 80);
    return () => window.clearInterval(timer);
  }, [captionsVisible, clockOffsetMs, service.active]);

  const caption = language ? captions[language] : undefined;
  const visibleFinal = useMemo(
    () =>
      playing ? visibleCaptionSegments(caption?.final ?? [], captionClock) : (caption?.final ?? []),
    [caption?.final, captionClock, playing],
  );
  const narratedSequence = useMemo(
    () =>
      playing ? narratedAnchorSequence(visibleFinal, captionClock) : visibleFinal.at(-1)?.sequence,
    [captionClock, visibleFinal, playing],
  );

  const scrollToNarrated = useCallback(
    (behavior: ScrollBehavior) => {
      const viewport = captionViewportRef.current;
      if (!viewport) return;
      const target =
        narratedSequence === undefined
          ? undefined
          : captionSegmentRefs.current.get(narratedSequence);
      const top = target
        ? Math.max(0, target.offsetTop - viewport.clientHeight * 0.42)
        : viewport.scrollHeight;
      programmaticScrollRef.current = true;
      if (programmaticScrollTimerRef.current !== undefined) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
      viewport.scrollTo({ top, behavior });
      programmaticScrollTimerRef.current = window.setTimeout(
        () => {
          programmaticScrollRef.current = false;
        },
        behavior === 'smooth' ? 450 : 50,
      );
    },
    [narratedSequence],
  );

  useLayoutEffect(() => {
    if (!followingLiveRef.current) return;
    scrollToNarrated('smooth');
  }, [captionsVisible, language, narratedSequence, scrollToNarrated]);

  useEffect(() => {
    followingLiveRef.current = true;
    setFollowingLive(true);
  }, [language]);

  const updateCaptionFollow = () => {
    const viewport = captionViewportRef.current;
    if (!viewport || programmaticScrollRef.current) return;
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 36;
    followingLiveRef.current = atBottom;
    setFollowingLive(atBottom);
  };

  const jumpToLive = () => {
    followingLiveRef.current = true;
    setFollowingLive(true);
    scrollToNarrated('smooth');
  };
  const beginManualCaptionScroll = () => {
    programmaticScrollRef.current = false;
  };
  const status = useMemo(() => {
    if (!service.active) return 'Service offline';
    if (!audioAvailable) return 'Live text · Audio off';
    if (!connected) return 'Ready to connect';
    return playing ? 'Listening live' : 'Paused';
  }, [connected, playing, service.active, audioAvailable]);

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
        <span className="delay">
          Live text appears as translation arrives. Audio may follow later.
        </span>
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
            <button
              className="listen"
              disabled={!audioAvailable}
              onClick={() => void beginListening()}
            >
              {!audioAvailable
                ? 'Audio off'
                : connecting
                  ? 'Cancel connection'
                  : playing
                    ? '❚❚  Pause'
                    : '▶  Listen'}
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
              {!audioAvailable
                ? 'Read live text below'
                : connected
                  ? 'Secure stream connected'
                  : 'Tap Listen to connect'}
            </div>
          </section>

          <section className={`captions ${captionsVisible ? '' : 'hidden'}`}>
            <div className="caption-title">
              <span>
                LIVE CAPTIONS
                {!followingLive && <em>Browsing earlier text</em>}
              </span>
              <div>
                {!followingLive && <button onClick={jumpToLive}>Jump to live</button>}
                <button onClick={() => setCaptionsVisible((visible) => !visible)}>
                  {captionsVisible ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            {captionsVisible && (
              <div
                className="caption-viewport"
                ref={captionViewportRef}
                onScroll={updateCaptionFollow}
                onPointerDown={beginManualCaptionScroll}
                onWheel={beginManualCaptionScroll}
              >
                <div className="caption-copy" aria-live="polite">
                  {visibleFinal.map((segment) => (
                    <span
                      className="caption-final"
                      key={`${segment.sessionId}-${segment.sequence}`}
                      ref={(element) => {
                        if (element) captionSegmentRefs.current.set(segment.sequence, element);
                        else captionSegmentRefs.current.delete(segment.sequence);
                      }}
                    >
                      {playing ? (
                        <CaptionWords segment={segment} now={captionClock} />
                      ) : (
                        segment.text
                      )}{' '}
                    </span>
                  ))}
                  {!caption?.final.length && !caption?.live ? (
                    <span className="caption-placeholder">
                      Captions will appear when the speaker begins.
                    </span>
                  ) : null}
                  {caption?.live &&
                    (caption.final.at(-1)?.sequence ?? -1) < caption.live.sequence && (
                      <p className="caption-live" key={`live-${caption.live.sequence}`}>
                        <small>
                          {caption.live.phase === 'transcribing'
                            ? 'Live transcription'
                            : 'Live translation'}
                        </small>
                        {caption.live.text}
                      </p>
                    )}
                </div>
              </div>
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
