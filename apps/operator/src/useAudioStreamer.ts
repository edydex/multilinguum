import { useEffect, useState } from 'react';
import { controlWebSocketProtocol, type OperatorConnection } from './api';
import type { CapturedPcmFrame } from './useAudioMeter';

export function useAudioStreamer(
  enabled: boolean,
  sessionId: string | undefined,
  connection: OperatorConnection,
  subscribePcm: (listener: (frame: CapturedPcmFrame) => void) => () => void,
) {
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled || !sessionId) {
      setStreaming(false);
      return;
    }
    let cancelled = false;
    let socket: WebSocket | undefined;
    let unsubscribePcm: (() => void) | undefined;
    let sequence = 0;

    const start = async () => {
      try {
        const url = new URL('/api/capture/audio', connection.baseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('sessionId', sessionId);
        socket = new WebSocket(url, controlWebSocketProtocol(connection.token));
        socket.binaryType = 'arraybuffer';
        await new Promise<void>((resolve, reject) => {
          if (!socket) return reject(new Error('Capture socket was not created.'));
          socket.onopen = () => resolve();
          socket.onerror = () => reject(new Error('Could not connect the capture stream.'));
          socket.onclose = (event) => {
            if (!cancelled && event.code !== 1000)
              setError(event.reason || 'Capture stream closed.');
            setStreaming(false);
          };
        });
        if (cancelled) return;
        unsubscribePcm = subscribePcm((frame) => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          const samples = new Uint8Array(frame.pcm);
          const packet = new ArrayBuffer(16 + samples.byteLength);
          const view = new DataView(packet);
          view.setUint32(0, sequence++, true);
          view.setFloat64(4, frame.capturedAtUnixMs, true);
          view.setUint32(12, samples.byteLength / 2, true);
          new Uint8Array(packet, 16).set(samples);
          socket.send(packet);
        });
        setError(undefined);
        setStreaming(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void start();
    return () => {
      cancelled = true;
      setStreaming(false);
      unsubscribePcm?.();
      socket?.close(1000, 'Service stopped');
    };
  }, [connection.baseUrl, connection.token, enabled, sessionId, subscribePcm]);

  return { streaming, error };
}
