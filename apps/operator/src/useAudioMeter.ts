import { useEffect, useState } from 'react';

export interface AudioDevice {
  id: string;
  label: string;
}

export function useAudioMeter(selectedDeviceId?: string) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let frame = 0;

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
        context = new AudioContext({ sampleRate: 48000 });
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const measure = () => {
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(
            samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
          );
          if (!cancelled) setLevel(Math.min(1, rms * 4));
          frame = requestAnimationFrame(measure);
        };
        measure();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [selectedDeviceId]);

  return { devices, level, error };
}
