import { useEffect, useRef, useState } from 'react';
import { controlWebSocketProtocol, operatorUrl, type OperatorConnection } from './api';
import type { CapturedPcmFrame } from './useAudioMeter';

export function useAudioStreamer(
  enabled: boolean,
  sessionId: string | undefined,
  connection: OperatorConnection,
  subscribePcm: (listener: (frame: CapturedPcmFrame) => void) => () => void,
) {
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string>();
  const token = useRef(connection.token);
  const currentSocket = useRef<WebSocket | undefined>(undefined);
  token.current = connection.token;

  // Renew authorization in place: changing a short-lived lease must not reopen the mixer.
  useEffect(() => {
    if (currentSocket.current?.readyState === WebSocket.OPEN) {
      currentSocket.current.send(JSON.stringify({ type: 'renew-auth', token: connection.token }));
    }
  }, [connection.token]);

  useEffect(() => {
    setStreaming(false);
    setError(undefined);
    if (!enabled || !sessionId) return;
    let cancelled = false;
    let unsubscribePcm: (() => void) | undefined;
    let sequence = 0;
    const url = operatorUrl('/api/capture/audio', connection.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('sessionId', sessionId);
    const socket = new WebSocket(url, controlWebSocketProtocol(token.current));
    currentSocket.current = socket;
    socket.binaryType = 'arraybuffer';
    const fail = (message: string) => {
      if (cancelled) return;
      unsubscribePcm?.();
      unsubscribePcm = undefined;
      setStreaming(false);
      setError(message);
      socket.close(1000, 'Audio input disconnected');
    };
    const timeout = window.setTimeout(
      () => fail('The processor did not become ready. Reconnect the mixer to try again.'),
      20000,
    );
    socket.onopen = () => socket.send(JSON.stringify({ type: 'renew-auth', token: token.current }));
    socket.onmessage = (message) => {
      if (cancelled) return;
      let event: { type?: string; sessionId?: string };
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (event.type !== 'capture-ready' || event.sessionId !== sessionId || unsubscribePcm) return;
      window.clearTimeout(timeout);
      unsubscribePcm = subscribePcm((frame) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        // Never accumulate stale sermon audio when a connection cannot keep up.
        if (socket.bufferedAmount > 192000) {
          fail(
            'The connection is too slow for live audio. Reconnect the mixer when the network recovers.',
          );
          return;
        }
        const samples = new Uint8Array(frame.pcm);
        const packet = new ArrayBuffer(16 + samples.byteLength);
        const view = new DataView(packet);
        view.setUint32(0, sequence++, true);
        view.setFloat64(4, frame.capturedAtUnixMs, true);
        view.setUint32(12, samples.byteLength / 2, true);
        new Uint8Array(packet, 16).set(samples);
        socket.send(packet);
      });
      setStreaming(true);
      setError(undefined);
    };
    socket.onerror = () => fail('Could not connect the mixer stream.');
    socket.onclose = (event) => {
      window.clearTimeout(timeout);
      unsubscribePcm?.();
      unsubscribePcm = undefined;
      if (!cancelled) {
        setStreaming(false);
        setError(event.reason || 'Audio input disconnected. Reconnect the mixer to continue.');
      }
    };
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      unsubscribePcm?.();
      if (currentSocket.current === socket) currentSocket.current = undefined;
      socket.close(1000, 'Audio input disconnected');
    };
  }, [connection.baseUrl, enabled, sessionId, subscribePcm]);

  return { streaming, error };
}
