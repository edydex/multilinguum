import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { rmsToDb, smoothDb } from './audioLevel';

export interface AudioDevice {
  id: string;
  label: string;
}

export interface CapturedPcmFrame {
  pcm: ArrayBuffer;
  capturedAtUnixMs: number;
}

interface WorkletFrame {
  pcm: ArrayBuffer;
  rms: number;
  peak: number;
  channel: number;
  channelCount: number;
}

interface NativeAudioInput {
  name: string;
  isDefault: boolean;
}

interface NativeAudioFrame {
  pcm: number[];
  rms: number;
  peak: number;
  channel: number;
  channelCount: number;
  capturedAtUnixMs: number;
}

interface NativeAudioConfig {
  deviceName: string;
  sampleRate: number;
  channelCount: number;
}

type PcmListener = (frame: CapturedPcmFrame) => void;

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export function useAudioMeter(selectedDeviceId: string | undefined, active = true) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [levelDb, setLevelDb] = useState(-60);
  const [activeChannel, setActiveChannel] = useState(0);
  const [channelCount, setChannelCount] = useState(0);
  const [sampleRate, setSampleRate] = useState(48_000);
  const [error, setError] = useState<string>();
  const listeners = useRef(new Set<PcmListener>());

  useEffect(() => {
    let cancelled = false;
    if (isTauriRuntime()) {
      void invoke<NativeAudioInput[]>('list_audio_inputs')
        .then((available) => {
          if (cancelled) return;
          setDevices(available.map((device) => ({ id: device.name, label: device.name })));
        })
        .catch((cause) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        });
      return () => {
        cancelled = true;
      };
    }
    const refreshDevices = async () => {
      const available = await navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      setDevices(
        available
          .filter((device) => device.kind === 'audioinput')
          .map((device, index) => ({
            id: device.deviceId,
            label: device.label || `Input ${index + 1}`,
          })),
      );
    };
    const handleDeviceChange = () => void refreshDevices();
    void refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, []);

  const subscribePcm = useCallback((listener: PcmListener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  useEffect(() => {
    if (!active) {
      setLevelDb(-60);
      setActiveChannel(0);
      setChannelCount(0);
      return;
    }
    if (isTauriRuntime()) {
      let cancelled = false;
      let unlistenFrame: UnlistenFn | undefined;
      let unlistenError: UnlistenFn | undefined;
      let lastMeterUpdate = 0;
      let smoothedDb = -60;
      const startNative = async () => {
        try {
          unlistenFrame = await listen<NativeAudioFrame>('audio-input-frame', (event) => {
            if (cancelled) return;
            const nextDb = rmsToDb(event.payload.rms);
            smoothedDb = smoothDb(smoothedDb, nextDb);
            if (event.payload.capturedAtUnixMs - lastMeterUpdate >= 50) {
              lastMeterUpdate = event.payload.capturedAtUnixMs;
              setLevelDb(smoothedDb);
              setActiveChannel(event.payload.channel);
              setChannelCount(event.payload.channelCount);
            }
            const samples = Int16Array.from(event.payload.pcm);
            const frame = {
              pcm: samples.buffer,
              capturedAtUnixMs: event.payload.capturedAtUnixMs,
            };
            for (const listener of listeners.current) listener(frame);
          });
          unlistenError = await listen<string>('audio-input-error', (event) => {
            if (!cancelled) setError(event.payload);
          });
          const config = await invoke<NativeAudioConfig>('start_audio_input', {
            deviceName: selectedDeviceId,
          });
          if (!cancelled) {
            setSampleRate(config.sampleRate);
            setChannelCount(config.channelCount);
            setError(undefined);
          }
        } catch (cause) {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        }
      };
      void startNative();
      return () => {
        cancelled = true;
        unlistenFrame?.();
        unlistenError?.();
        void invoke('stop_audio_input');
      };
    }
    let cancelled = false;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let processor: AudioWorkletNode | undefined;
    let lastMeterUpdate = 0;
    let smoothedDb = -60;

    const start = async () => {
      try {
        const constraints: MediaTrackConstraints = {
          ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
          // Keep the device's native layout so a feed wired to channel 2 is not lost.
          // The worklet selects the stronger channel and emits 48 kHz mono PCM.
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48_000 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        const available = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) {
          setDevices(
            available
              .filter((device) => device.kind === 'audioinput')
              .map((device, index) => ({
                id: device.deviceId,
                label: device.label || `Input ${index + 1}`,
              })),
          );
        }
        const settings = stream.getAudioTracks()[0]?.getSettings();
        if (!cancelled) {
          setSampleRate(settings?.sampleRate ?? 48_000);
          setError(undefined);
        }
        context = new AudioContext({ sampleRate: 48_000 });
        await context.audioWorklet.addModule('/pcm-worklet.js');
        const source = context.createMediaStreamSource(stream);
        processor = new AudioWorkletNode(context, 'multilinguum-pcm');
        const silent = context.createGain();
        silent.gain.value = 0;
        source.connect(processor);
        processor.connect(silent).connect(context.destination);
        processor.port.onmessage = (message: MessageEvent<WorkletFrame>) => {
          if (cancelled) return;
          const receivedAt = Date.now();
          const nextDb = rmsToDb(message.data.rms);
          smoothedDb = smoothDb(smoothedDb, nextDb);
          if (receivedAt - lastMeterUpdate >= 50) {
            lastMeterUpdate = receivedAt;
            setLevelDb(smoothedDb);
            setActiveChannel(message.data.channel);
            setChannelCount(message.data.channelCount);
          }
          const frame = { pcm: message.data.pcm, capturedAtUnixMs: receivedAt };
          for (const listener of listeners.current) listener(frame);
        };
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void start();
    return () => {
      cancelled = true;
      processor?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [active, selectedDeviceId]);

  return {
    devices,
    levelDb,
    activeChannel,
    channelCount,
    sampleRate,
    subscribePcm,
    error,
  };
}
