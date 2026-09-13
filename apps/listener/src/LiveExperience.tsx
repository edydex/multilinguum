import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Language } from '@multilinguum/protocol';
import { AudioFocus, type AudioChoice } from './audio-focus';
import { CaptionPanel } from './CaptionPanel';
import { useBufferedAudio } from './useBufferedAudio';
import { VideoTimeline, type VideoSample } from './video-timeline';
import { useLiveAudio } from './useLiveAudio';
import { usePublicService } from './usePublicService';
import { YouTubePlayer, type VideoControls } from './YouTubePlayer';
import styles from './styles.css?inline';

const names: Record<Language, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  uk: 'Українська',
};
type PiPWindow = Window & {
  documentPictureInPicture?: {
    requestWindow(options: { width: number; height: number }): Promise<Window>;
  };
};
export interface LiveExperienceOptions {
  apiBase: string;
  churchName?: string;
  videoId?: string | null;
  channelUrl?: string | null;
  broadcastDelaySeconds?: number;
}

export function LiveExperience({
  apiBase,
  churchName,
  videoId,
  channelUrl,
  broadcastDelaySeconds = 0,
}: LiveExperienceOptions) {
  const { service, captions, audioWindow, connection, clockOffsetMs } = usePublicService(
    apiBase,
    churchName,
  );
  const [language, setLanguage] = useState<Language | undefined>(() => {
    try {
      const saved = localStorage.getItem('heritage-live-text-language');
      if (saved && Object.hasOwn(names, saved)) return saved as Language;
    } catch {
      /* Browser storage is optional. */
    }
    return 'en';
  });
  const [audioChoice, setAudioChoice] = useState<AudioChoice>(videoId ? 'original' : 'muted');
  const [volume, setVolume] = useState(1);
  const [delaySeconds, setDelaySeconds] = useState(() =>
    Math.min(180, Math.max(0, broadcastDelaySeconds)),
  );
  const [sourceNow, setSourceNow] = useState<number>();
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [textFollowsVideo, setTextFollowsVideo] = useState(true);
  const [needsAlignment, setNeedsAlignment] = useState(false);
  const timeline = useRef(new VideoTimeline());
  const timing = useRef({ clockOffsetMs, delaySeconds });
  timing.current = { clockOffsetMs, delaySeconds };
  const [notice, setNotice] = useState<string>();
  const [floating, setFloating] = useState<Window>();
  const [openingFloat, setOpeningFloat] = useState(false);
  const [inlineFloating, setInlineFloating] = useState(false);
  const floatRef = useRef<Window | undefined>(undefined);
  const mounted = useRef(true);
  const video = useRef<VideoControls | undefined>(undefined);
  const focusBusy = useRef(0);
  const canListen = connection === 'live' && service.active;
  const availableAudio = canListen
    ? service.languages
        .filter(
          (item) =>
            item.available &&
            item.audioAvailable !== false &&
            (!videoId ||
              (item.voiceMode !== 'source' &&
                item.bufferedAudioAvailable &&
                videoPlaying &&
                !needsAlignment)),
        )
        .map((item) => item.language)
    : [];
  const bufferedLanguages = availableAudio.filter((language) =>
    service.languages.some((item) => item.language === language && item.bufferedAudioAvailable),
  );
  const legacy = useLiveAudio(
    apiBase,
    availableAudio.filter((language) => !bufferedLanguages.includes(language)),
    volume,
  );
  const buffered = useBufferedAudio(
    apiBase,
    bufferedLanguages,
    audioWindow,
    volume,
    sourceNow,
    clockOffsetMs,
    Boolean(videoId),
  );
  const usesBuffer =
    audioChoice !== 'original' &&
    audioChoice !== 'muted' &&
    bufferedLanguages.includes(audioChoice);
  const audio = {
    ...(usesBuffer ? buffered : legacy),
    stop: () => {
      buffered.stop();
      legacy.stop();
    },
    start: (selected: Language) =>
      bufferedLanguages.includes(selected) ? buffered.start(selected) : legacy.start(selected),
  };
  const current = useRef({ audio, videoId, audioChoice });
  current.current = { audio, videoId, audioChoice };
  const focus = useMemo(
    () =>
      new AudioFocus({
        stopTranslation: () => current.current.audio.stop(),
        muteOriginal: async () =>
          !current.current.videoId || (await video.current?.mute()) === true,
        unmuteOriginal: () => video.current?.unmute(),
        startTranslation: async (selected) => {
          await current.current.audio.start(selected);
        },
        changed: (selected) => setAudioChoice(selected),
        failed: (message) => setNotice(message),
      }),
    [],
  );
  const chooseAudio = useCallback(
    async (choice: AudioChoice) => {
      setNotice(undefined);
      if (choice !== 'original' && choice !== 'muted' && bufferedLanguages.includes(choice)) {
        try {
          void buffered.prepare().catch(() => undefined);
        } catch {
          /* start reports unsupported playback. */
        }
      }
      focusBusy.current += 1;
      try {
        await focus.choose(choice);
      } finally {
        focusBusy.current -= 1;
      }
    },
    [focus, buffered.prepare, bufferedLanguages.join(',')],
  );

  useEffect(() => {
    if (!service.languages.length) return;
    setLanguage((selected) =>
      service.languages.some((item) => item.language === selected && item.available)
        ? selected
        : service.languages.find((item) => item.available)?.language,
    );
  }, [service.languages]);
  const previousSession = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const selected = current.current.audioChoice;
    const changedSession = previousSession.current !== service.sessionId;
    previousSession.current = service.sessionId;
    if (changedSession || connection !== 'live') focus.cancel();
    if (
      selected !== 'muted' &&
      selected !== 'original' &&
      (changedSession || !availableAudio.includes(selected))
    ) {
      focus.cancel();
      setAudioChoice('muted');
      setNotice(
        connection !== 'live'
          ? 'Translation disconnected. Choose audio again after it reconnects.'
          : 'Translated audio has stopped. Live text remains available.',
      );
    }
  }, [service.sessionId, connection, audioChoice, availableAudio.join(','), focus]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      focus.cancel();
      floatRef.current?.close();
    };
  }, [focus]);
  const receiveVideoSample = useCallback((sample: VideoSample) => {
    setVideoPlaying(sample.playing);
    const at = timeline.current.sample(
      sample,
      Date.now() + timing.current.clockOffsetMs,
      timing.current.delaySeconds * 1000,
    );
    if (at !== undefined) setSourceNow(at);
  }, []);
  useLayoutEffect(() => {
    timeline.current.reset();
    setSourceNow(undefined);
    setNeedsAlignment(false);
    setDelaySeconds(Math.min(180, Math.max(0, broadcastDelaySeconds)));
  }, [videoId, service.sessionId, broadcastDelaySeconds]);
  const interruptVideo = useCallback(() => {
    timeline.current.interrupt();
    setNeedsAlignment(timeline.current.needsAlignment);
    setVideoPlaying(false);
    const selected = current.current.audioChoice;
    focus.cancel();
    if ((selected !== 'original' && selected !== 'muted') || focusBusy.current > 0) {
      setAudioChoice('muted');
      setNotice(
        'Video paused or moved. Return to the live broadcast before choosing translated audio again.',
      );
    }
  }, [focus]);
  const nativeUnmute = useCallback(() => {
    if (focusBusy.current) return;
    focus.cancel();
    setAudioChoice('original');
  }, [focus]);
  const openFloat = async () => {
    if (floatRef.current) {
      floatRef.current.close();
      return;
    }
    const pip = (window as PiPWindow).documentPictureInPicture;
    if (openingFloat) return;
    if (!pip) {
      setInlineFloating(true);
      return;
    }
    setOpeningFloat(true);
    try {
      const next = await pip.requestWindow({ width: 460, height: 620 });
      if (!mounted.current) {
        next.close();
        return;
      }
      next.document.title = 'Live translation';
      const style = next.document.createElement('style');
      style.textContent = styles;
      next.document.head.append(style);
      floatRef.current = next;
      setInlineFloating(false);
      setFloating(next);
      next.addEventListener(
        'pagehide',
        () => {
          if (floatRef.current === next) {
            floatRef.current = undefined;
            if (mounted.current) setFloating(undefined);
          }
        },
        { once: true },
      );
    } catch {
      if (mounted.current) {
        setInlineFloating(true);
        setNotice('Keep this tab open to use the floating panel.');
      }
    } finally {
      if (mounted.current) setOpeningFloat(false);
    }
  };
  const controls = (
    <div className="translation-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{churchName ?? service.churchName}</p>
          <h2>Live translation</h2>
        </div>
        {inlineFloating && (window as PiPWindow).documentPictureInPicture && (
          <button disabled={openingFloat} onClick={() => void openFloat()}>
            Pop out ↗
          </button>
        )}
        {(floating || inlineFloating) && (
          <button
            onClick={() => {
              floating?.close();
              setInlineFloating(false);
            }}
          >
            Return to page
          </button>
        )}
      </div>
      <p className={`connection-status ${canListen ? 'is-live' : ''}`} role="status">
        <span />
        {connection !== 'live'
          ? 'Connecting to translation…'
          : service.active
            ? 'Translation is live'
            : 'Waiting for the next service'}
      </p>
      <div className="language-controls">
        <label>
          Read text
          <select
            value={language ?? ''}
            onChange={(event) => {
              const selected = event.target.value as Language;
              setLanguage(selected);
              try {
                localStorage.setItem('heritage-live-text-language', selected);
              } catch {
                /* Optional preference only. */
              }
            }}
            disabled={!service.active}
          >
            {!language && <option value="">Waiting for translation</option>}
            {service.languages.map((item) => (
              <option key={item.language} value={item.language} disabled={!item.available}>
                {names[item.language]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Listen to
          <select
            value={audioChoice}
            onChange={(event) => void chooseAudio(event.target.value as AudioChoice)}
          >
            <option value="muted">Audio off</option>
            {videoId && <option value="original">Original · YouTube</option>}
            {service.languages
              .filter((item) => !videoId || item.voiceMode !== 'source')
              .map((item) => (
                <option
                  key={item.language}
                  value={item.language}
                  disabled={!availableAudio.includes(item.language)}
                >
                  {names[item.language]}
                  {videoId && item.audioAvailable !== false && !item.bufferedAudioAvailable
                    ? ' · in-person audio only'
                    : item.audioAvailable === false
                      ? ' · audio off'
                      : item.voiceMode === 'source'
                        ? ' · original'
                        : ' · translated'}
                </option>
              ))}
          </select>
        </label>
      </div>
      {audioChoice !== 'muted' && audioChoice !== 'original' && (
        <div className="audio-controls">
          <span role="status">
            {audio.connecting
              ? 'Connecting audio…'
              : audio.playing
                ? 'Listening live'
                : audio.connected
                  ? 'Waiting for audio…'
                  : 'Audio stopped'}
          </span>
          <button
            onClick={() =>
              void chooseAudio(
                audio.connecting || audio.playing || audio.connected ? 'muted' : audioChoice,
              )
            }
          >
            {audio.connecting
              ? 'Cancel'
              : audio.playing || audio.connected
                ? 'Stop audio'
                : 'Retry audio'}
          </button>
          <label>
            Volume
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              aria-label="Translated audio volume"
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </label>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {audio.error && (
        <p className="error" role="alert">
          {audio.error}
        </p>
      )}
      {videoId && (
        <details className="timing-controls" open={needsAlignment || undefined}>
          <summary>Match translation to video · {delaySeconds} s delay</summary>
          <p>
            Start at YouTube’s LIVE position. If translation appears or plays too early, increase
            the delay. If it is late, decrease it.
          </p>
          <label>
            Match text to video
            <input
              type="checkbox"
              checked={textFollowsVideo}
              onChange={(event) => setTextFollowsVideo(event.target.checked)}
            />
          </label>
          {!textFollowsVideo && <p>Text appears as it arrives, independently of the video.</p>}
          <label>
            Translation delay (seconds)
            <input
              type="number"
              min="0"
              max="180"
              step="1"
              value={delaySeconds}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                void chooseAudio('muted');
                setDelaySeconds(Math.min(180, Math.max(0, value)));
                setNotice('Timing changed. Choose translated audio again when ready.');
              }}
            />
          </label>
          {needsAlignment && (
            <p>
              Video playback changed. Return to LIVE at normal speed, then match translation again.
            </p>
          )}
          <button
            disabled={!videoPlaying}
            onClick={() => {
              void chooseAudio('muted');
              if (timeline.current.align(Date.now() + clockOffsetMs)) {
                setNeedsAlignment(false);
                setNotice('Translation timing reset. Choose audio when ready.');
              }
            }}
          >
            Match to current live position
          </button>
          <p>
            The church’s {broadcastDelaySeconds} s setting is a starting point. Your video
            connection may need a different delay.
          </p>
        </details>
      )}
      {usesBuffer && buffered.notice && (
        <p role="status" className="notice">
          {buffered.notice}
        </p>
      )}
      <CaptionPanel
        caption={language ? captions[language] : undefined}
        language={language}
        narrated={!usesBuffer && audio.playing && audioChoice === language}
        clockOffsetMs={clockOffsetMs}
        video={Boolean(videoId) && textFollowsVideo}
        sourceNow={sourceNow}
        sessionStartedAt={service.startedAt}
      />
      <p className="disclosure">
        AI translation may contain errors.{' '}
        {videoId
          ? textFollowsVideo
            ? 'Translation follows the measured video delay. Adjust timing if your stream differs.'
            : 'Text appears as it arrives. Translated audio uses the measured video delay.'
          : 'Text appears as it arrives; spoken translation may follow later.'}
      </p>
    </div>
  );

  return (
    <section
      aria-label="Live service player"
      className={`live-experience ${videoId ? 'with-video' : ''}`}
    >
      {videoId && (
        <YouTubePlayer
          videoId={videoId}
          controls={video}
          originalWanted={audioChoice === 'original'}
          onInterrupted={interruptVideo}
          onNativeUnmute={nativeUnmute}
          onSample={receiveVideoSample}
        />
      )}
      {!videoId && channelUrl && (
        <div className="service-link">
          <p>No video has been selected for this service.</p>
          <a href={channelUrl} target="_blank" rel="noreferrer">
            Visit the church’s YouTube channel ↗
          </a>
        </div>
      )}
      <div className="translation-container">
        {
          <button
            className="float-button"
            onClick={() => {
              if (floating) floating.close();
              else setInlineFloating((value) => !value);
            }}
          >
            {floating || inlineFloating ? 'Bring translation back' : 'Float translation ↗'}
          </button>
        }
        {floating ? (
          <>
            <div className="floating-placeholder">
              <h2>Translation is in the floating window</h2>
              <p>Your text and audio choices stay connected.</p>
              <button onClick={() => floating.close()}>Bring translation back</button>
            </div>
            {createPortal(
              <div className="live-experience floating">{controls}</div>,
              floating.document.body,
            )}
          </>
        ) : inlineFloating ? (
          <div
            className="live-experience floating inline-floating"
            role="region"
            aria-label="Floating translation"
          >
            {controls}
          </div>
        ) : (
          controls
        )}
      </div>
    </section>
  );
}
