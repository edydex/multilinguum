import { useEffect, useState } from 'react';
import type { OperatorConnection } from './api';

export function useAudioStreamer(
  enabled: boolean,
  sessionId: string | undefined,
  selectedDeviceId: string | undefined,
  connection: OperatorConnection,
) {
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled || !sessionId) {
      setStreaming(false);
      return;
    }
    let cancelled = false;
    let media: MediaStream | undefined;
    let context: AudioContext | undefined;
    let socket: WebSocket | undefined;
    let processor: AudioWorkletNode | undefined;
    let sequence = 0;

    const start = async () => {
      try {
        const constraints: MediaTrackConstraints = {
          ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
        media = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        context = new AudioContext({ sampleRate: 48000 });
        await context.audioWorklet.addModule('/pcm-worklet.js');
        const url = new URL('/api/capture/audio', connection.baseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('token', connection.token);
        url.searchParams.set('sessionId', sessionId);
        socket = new WebSocket(url);
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
        const source = context.createMediaStreamSource(media);
        processor = new AudioWorkletNode(context, 'multilinguum-pcm');
        const silent = context.createGain();
        silent.gain.value = 0;
        source.connect(processor);
        processor.connect(silent).connect(context.destination);
        processor.port.onmessage = (message: MessageEvent<ArrayBuffer>) => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          const samples = new Uint8Array(message.data);
          const packet = new ArrayBuffer(16 + samples.byteLength);
          const view = new DataView(packet);
          view.setUint32(0, sequence++, true);
          view.setFloat64(4, Date.now(), true);
          view.setUint32(12, samples.byteLength / 2, true);
          new Uint8Array(packet, 16).set(samples);
          socket.send(packet);
        };
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
      processor?.disconnect();
      media?.getTracks().forEach((track) => track.stop());
      socket?.close(1000, 'Service stopped');
      void context?.close();
    };
  }, [connection.baseUrl, connection.token, enabled, selectedDeviceId, sessionId]);

  return { streaming, error };
}
