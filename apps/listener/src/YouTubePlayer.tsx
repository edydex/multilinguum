import { useEffect, useRef, useState } from 'react';

interface Player {
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}
type YouTubeWindow = Window & {
  YT?: { Player: new (element: HTMLElement, options: unknown) => Player };
  onYouTubeIframeAPIReady?: () => void;
};
export interface VideoControls {
  mute(): Promise<boolean>;
  unmute(): void;
}
let apiReady: Promise<void> | undefined;

function loadYouTube(): Promise<void> {
  const target = window as YouTubeWindow;
  if (target.YT?.Player) return Promise.resolve();
  if (apiReady) return apiReady;
  apiReady = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    const previous = target.onYouTubeIframeAPIReady;
    const timeout = window.setTimeout(() => reject(new Error('YouTube did not load.')), 15000);
    target.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      previous?.();
      resolve();
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('YouTube could not be reached.'));
    };
    document.head.append(script);
  }).catch((cause) => {
    apiReady = undefined;
    throw cause;
  });
  return apiReady;
}

export function YouTubePlayer({
  videoId,
  controls,
  originalWanted,
  onInterrupted,
  onNativeUnmute,
}: {
  videoId: string;
  controls: React.MutableRefObject<VideoControls | undefined>;
  originalWanted: boolean;
  onInterrupted(): void;
  onNativeUnmute(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ originalWanted, onInterrupted, onNativeUnmute });
  latest.current = { originalWanted, onInterrupted, onNativeUnmute };
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stopped = false;
    let player: Player | undefined;
    let timer: number | undefined;
    let readyTimer: number | undefined;
    let sample: { time: number; wall: number } | undefined;
    const init = async () => {
      try {
        await loadYouTube();
        if (stopped || !host.current) return;
        const slot = document.createElement('div');
        host.current.replaceChildren(slot);
        readyTimer = window.setTimeout(() => {
          if (!stopped)
            setError(
              'YouTube has not loaded. You can open the service on YouTube while continuing to read here.',
            );
        }, 15000);
        player = new (window as YouTubeWindow).YT!.Player(slot, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, origin: window.location.origin, rel: 0 },
          events: {
            onReady: () => {
              if (stopped || !player) return;
              window.clearTimeout(readyTimer);
              setError(undefined);
              if (!latest.current.originalWanted) player.mute();
              controls.current = {
                mute: async () => {
                  player?.mute();
                  const deadline = Date.now() + 2000;
                  while (!stopped && player && Date.now() < deadline) {
                    if (player.isMuted()) return true;
                    await new Promise((resolve) => window.setTimeout(resolve, 40));
                  }
                  return false;
                },
                unmute: () => player?.unMute(),
              };
              timer = window.setInterval(() => {
                if (!player) return;
                // YouTube exposes no volume event. Native control changes are observed here.
                if (!latest.current.originalWanted && !player.isMuted())
                  latest.current.onNativeUnmute();
                const wall = Date.now();
                const time = player.getCurrentTime();
                if (
                  sample &&
                  player.getPlayerState() === 1 &&
                  Math.abs(time - sample.time - (wall - sample.wall) / 1000) > 2
                )
                  latest.current.onInterrupted();
                sample = { time, wall };
              }, 200);
            },
            onStateChange: (event: { data: number }) => {
              if (event.data === 2 || event.data === 0) latest.current.onInterrupted();
              sample = undefined;
            },
            onError: () => {
              window.clearTimeout(readyTimer);
              latest.current.onInterrupted();
              setError('This video cannot play here. Open the service on YouTube.');
            },
          },
        });
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    setError(undefined);
    void init();
    return () => {
      stopped = true;
      controls.current = undefined;
      window.clearInterval(timer);
      window.clearTimeout(readyTimer);
      player?.destroy();
    };
  }, [videoId, controls]);
  return (
    <section className="video-section" aria-label="Church video stream">
      <div className="video-player" ref={host} />
      {error && <p role="alert">{error}</p>}
      <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">
        Open on YouTube ↗
      </a>
    </section>
  );
}
