import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Language } from '@multilinguum/protocol';
import type { AudioWindow } from './audio-window';
import { BufferedPlayer } from './buffered-player';
import { publicEndpoint } from './public-endpoint';

export function useBufferedAudio(
  apiBase: string,
  available: Language[],
  window: AudioWindow,
  volume: number,
  sourceNow: number | undefined,
  clockOffsetMs: number,
  video: boolean,
) {
  const [connected, setConnected] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const context = useRef<AudioContext | undefined>(undefined);
  const gain = useRef<GainNode | undefined>(undefined);
  const player = useRef<BufferedPlayer | undefined>(undefined);
  const selected = useRef<Language | undefined>(undefined);
  const attempt = useRef(0);
  const latest = useRef({ available, window, volume, sourceNow, clockOffsetMs });
  latest.current = { available, window, volume, sourceNow, clockOffsetMs };
  // Called synchronously from the listener's click, before waiting for YouTube mute.
  const prepare = useCallback(() => {
    context.current ??= new AudioContext();
    if (!gain.current) {
      gain.current = context.current.createGain();
      gain.current.connect(context.current.destination);
    }
    gain.current.gain.value = latest.current.volume;
    return context.current.resume();
  }, []);
  const stop = useCallback(() => {
    attempt.current++;
    player.current?.stop();
    player.current = undefined;
    selected.current = undefined;
    setConnected(false);
    setPlaying(false);
    setConnecting(false);
    setError(undefined);
    setNotice(undefined);
  }, []);
  const start = useCallback(
    async (language: Language) => {
      stop();
      if (!latest.current.available.includes(language)) return;
      const currentAttempt = attempt.current;
      selected.current = language;
      setConnecting(true);
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            prepare(),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Choose Retry audio to allow playback.')),
                3000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        if (attempt.current !== currentAttempt) return;
        if (context.current?.state !== 'running')
          throw new Error('Choose audio again to allow playback.');
        const output = context.current;
        output.onstatechange = () => {
          if (player.current && output.state !== 'running') {
            stop();
            setError('Audio was interrupted. Choose audio again to resume.');
          }
        };
        const next = new BufferedPlayer(
          {
            clock: () => ({
              sourceNow: latest.current.sourceNow ?? NaN,
              serverNow: Date.now() + latest.current.clockOffsetMs,
            }),
            changed: setPlaying,
            late: () =>
              setNotice(
                'A translated phrase arrived too late. Increase the translation delay to allow more time.',
              ),
            failed: (message) => {
              stop();
              setError(message);
            },
            load: async (clip, signal) => {
              const url = publicEndpoint(apiBase, `audio/${clip.sessionId}/${clip.id}.wav`);
              const response = await fetch(url, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
                cache: 'no-store',
              });
              if (!response.ok) throw new Error('The audio window changed. Choose audio again.');
              const bytes = await response.arrayBuffer();
              if (bytes.byteLength !== clip.byteLength)
                throw new Error('Audio could not be loaded completely.');
              const buffer = await output.decodeAudioData(bytes);
              return {
                durationMs: buffer.duration * 1000,
                play: (delayMs, ended) => {
                  const node = output.createBufferSource();
                  node.buffer = buffer;
                  node.connect(gain.current!);
                  node.onended = () => {
                    node.disconnect();
                    ended();
                  };
                  node.start(output.currentTime + delayMs / 1000);
                  return () => {
                    node.onended = null;
                    node.stop();
                    node.disconnect();
                  };
                },
              };
            },
          },
          video,
        );
        player.current = next;
        next.start();
        setConnected(true);
        setConnecting(false);
      } catch (cause) {
        if (attempt.current !== currentAttempt) return;
        stop();
        setError(cause instanceof Error ? cause.message : 'Audio could not start.');
      }
    },
    [apiBase, prepare, stop, video],
  );
  const availabilityKey = available.join(',');
  const generationKey = JSON.stringify([window.sessionId, window.generations]);
  useLayoutEffect(() => {
    stop();
  }, [apiBase, video, generationKey, stop]);
  useLayoutEffect(() => {
    if (selected.current && !available.includes(selected.current)) stop();
  }, [availabilityKey, stop]);
  useLayoutEffect(() => {
    if (gain.current) gain.current.gain.value = volume;
  }, [volume]);
  useLayoutEffect(() => {
    const timer = globalThis.setInterval(() => {
      const language = selected.current;
      if (!language) return;
      const clips = latest.current.window.clips.filter((clip) => clip.language === language);
      void player.current?.tick(clips);
    }, 100);
    return () => {
      globalThis.clearInterval(timer);
      stop();
      if (context.current) context.current.onstatechange = null;
      void context.current?.close();
      context.current = undefined;
      gain.current = undefined;
    };
  }, [stop]);
  return { connected, playing, connecting, error, notice, prepare, start, stop };
}
