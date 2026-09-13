import { useEffect, useState } from 'react';
import type { ProcessorEvent, PublicServiceState } from '@multilinguum/protocol';
import { mergeCaption, type CaptionTimeline } from './caption-timeline';
import { publicEndpoint } from './public-endpoint';

export function usePublicService(apiBase: string, churchName = 'Church community') {
  const [service, setService] = useState<PublicServiceState>({
    active: false,
    churchName,
    languages: [],
    serverTimeUnixMs: Date.now(),
  });
  const [captions, setCaptions] = useState<Record<string, CaptionTimeline>>({});
  const [connection, setConnection] = useState<'connecting' | 'live' | 'disconnected'>(
    'connecting',
  );
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  useEffect(() => {
    let stopped = false;
    let sessionId: string | undefined;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retryDelay = 1000;
    let lastMessageAt = Date.now();
    let receivedSocketState = false;
    const abort = new AbortController();
    const applyState = (next: PublicServiceState, sampledAt: number) => {
      if (stopped) return;
      if (sessionId !== next.sessionId) {
        setCaptions({});
        sessionId = next.sessionId;
      }
      setService(next);
      setClockOffsetMs(next.serverTimeUnixMs - sampledAt);
    };
    const load = async () => {
      const requestedAt = Date.now();
      try {
        const response = await fetch(publicEndpoint(apiBase, 'service'), {
          signal: abort.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Service unavailable');
        const next = (await response.json()) as PublicServiceState;
        if (!receivedSocketState) applyState(next, (requestedAt + Date.now()) / 2);
      } catch {
        /* The socket retries; stale state never authorizes playback. */
      }
    };
    const connect = () => {
      if (stopped) return;
      setConnection('connecting');
      const url = publicEndpoint(apiBase, 'events');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const next = new WebSocket(url);
      socket = next;
      lastMessageAt = Date.now();
      next.onmessage = (message) => {
        if (stopped || socket !== next) return;
        try {
          const event = JSON.parse(String(message.data)) as
            ProcessorEvent | { type: 'public-state'; state: PublicServiceState };
          lastMessageAt = Date.now();
          if (event.type === 'public-state') {
            receivedSocketState = true;
            applyState(event.state, Date.now());
            setConnection('live');
            retryDelay = 1000;
          } else if (event.type === 'transcript' && event.segment.sessionId === sessionId) {
            setCaptions((current) => ({
              ...current,
              [event.segment.language]: mergeCaption(
                current[event.segment.language],
                event.segment,
              ),
            }));
          } else if (event.type === 'session') {
            // Compatibility with processors predating the public-state heartbeat.
            receivedSocketState = false;
            void load();
          }
        } catch {
          /* Ignore malformed public events. */
        }
      };
      next.onerror = () => next.close();
      next.onclose = () => {
        if (stopped || socket !== next) return;
        setConnection('disconnected');
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
      };
    };
    setCaptions({});
    void load();
    connect();
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastMessageAt > 30000) {
        setConnection('disconnected');
        socket?.close();
      }
    }, 5000);
    return () => {
      stopped = true;
      abort.abort();
      window.clearInterval(watchdog);
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [apiBase]);
  return { service, captions, connection, clockOffsetMs };
}
