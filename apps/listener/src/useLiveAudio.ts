import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RemoteAudioTrack, Room } from 'livekit-client';
import type { Language } from '@multilinguum/protocol';

/** Listener preference only: this never starts or changes provider generation. */
export function useLiveAudio(
  apiBase: string,
  language: Language | undefined,
  available: boolean,
  volume: number,
) {
  const [connected, setConnected] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const room = useRef<Room | undefined>(undefined);
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  const tracks = useRef(new Map<Language, RemoteAudioTrack>());
  const wanted = useRef(false);
  const generation = useRef(0);
  const selection = useRef({ language, available, volume });

  const detach = useCallback(() => {
    const previous = audio.current;
    if (!previous) return;
    previous.pause();
    for (const track of tracks.current.values()) track.detach(previous);
    previous.remove();
    audio.current = undefined;
  }, []);

  const stop = useCallback(() => {
    wanted.current = false;
    generation.current += 1;
    detach();
    const previous = room.current;
    room.current = undefined;
    void previous?.disconnect();
    tracks.current.clear();
    setConnected(false);
    setConnecting(false);
    setPlaying(false);
  }, [detach]);

  const attachSelected = useCallback(() => {
    detach();
    setPlaying(false);
    const selected = selection.current;
    if (!wanted.current || !selected.available || !selected.language) return;
    const track = tracks.current.get(selected.language);
    if (!track) return;
    const element = track.attach();
    element.volume = selected.volume;
    element.autoplay = false;
    element.controls = false;
    document.body.append(element);
    audio.current = element;
    void element
      .play()
      .then(() => {
        if (audio.current === element && wanted.current && selection.current.available)
          setPlaying(true);
        else element.pause();
      })
      .catch(() => {
        if (audio.current !== element) return;
        wanted.current = false;
        detach();
        setPlaying(false);
        setError('Tap Listen to allow audio playback.');
      });
  }, [detach]);

  useLayoutEffect(() => {
    selection.current = { language, available, volume };
    if (!available) stop();
    else if (wanted.current) attachSelected();
  }, [language, available, attachSelected, stop]);

  useLayoutEffect(() => {
    selection.current.volume = volume;
    if (audio.current) audio.current.volume = volume;
  }, [volume]);

  useLayoutEffect(() => () => stop(), [stop]);

  const toggle = async () => {
    if (wanted.current) {
      stop();
      return;
    }
    if (!selection.current.available || !selection.current.language) return;
    wanted.current = true;
    const attempt = ++generation.current;
    const isCurrent = () =>
      generation.current === attempt && wanted.current && selection.current.available;
    setConnecting(true);
    setError(undefined);
    try {
      const { Room: LiveKitRoom, RoomEvent } = await import('livekit-client');
      if (!isCurrent()) return;
      const tokenUrl = new URL('/api/public/token', apiBase);
      tokenUrl.searchParams.set('language', selection.current.language!);
      const response = await fetch(tokenUrl, { signal: AbortSignal.timeout(10_000) });
      if (!isCurrent()) return;
      if (!response.ok) throw new Error('The audio stream is not ready yet.');
      const credentials = (await response.json()) as { url: string; token: string };
      if (!isCurrent()) return;
      const nextRoom = new LiveKitRoom({ adaptiveStream: true, dynacast: false });
      room.current = nextRoom;
      nextRoom.on(RoomEvent.TrackSubscribed, (track, publication) => {
        if (!isCurrent() || track.kind !== 'audio') return;
        const match = publication.trackName.match(/(?:translation|source)-(en|ru|es|uk)$/);
        if (!match) return;
        tracks.current.set(match[1] as Language, track as RemoteAudioTrack);
        if (match[1] === selection.current.language) attachSelected();
      });
      nextRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        for (const [key, existing] of tracks.current) {
          if (existing === track) tracks.current.delete(key);
        }
        if (isCurrent()) attachSelected();
      });
      nextRoom.on(RoomEvent.Disconnected, () => {
        if (isCurrent()) stop();
      });
      nextRoom.on(RoomEvent.Reconnecting, () => {
        if (isCurrent()) {
          detach();
          setPlaying(false);
          setConnected(false);
        }
      });
      nextRoom.on(RoomEvent.Reconnected, () => {
        if (isCurrent()) {
          setConnected(true);
          attachSelected();
        }
      });
      await nextRoom.connect(credentials.url, credentials.token, { autoSubscribe: true });
      if (!isCurrent()) {
        await nextRoom.disconnect();
        return;
      }
      await nextRoom.startAudio();
      if (!isCurrent()) {
        await nextRoom.disconnect();
        return;
      }
      setConnected(true);
      setConnecting(false);
      attachSelected();
    } catch (cause) {
      if (!isCurrent()) return;
      stop();
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useLayoutEffect(() => {
    if (connected && language) {
      void room.current?.localParticipant
        .setMetadata(JSON.stringify({ role: 'anonymous-listener', language }))
        .catch(() => undefined);
    }
  }, [connected, language]);

  return { connected, playing, connecting, error, toggle };
}
