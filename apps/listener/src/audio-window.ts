import type { BufferedAudioClip, PublicServiceState } from '@multilinguum/protocol';

export interface AudioWindow {
  sessionId?: string | undefined;
  generations: Record<string, number>;
  clips: BufferedAudioClip[];
}
export const emptyAudioWindow = (): AudioWindow => ({ generations: {}, clips: [] });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function validAudioClip(clip: BufferedAudioClip): boolean {
  return (
    !!clip &&
    uuid.test(clip.id) &&
    uuid.test(clip.sessionId) &&
    typeof clip.channelId === 'string' &&
    clip.channelId.length <= 100 &&
    ['en', 'ru', 'es', 'uk'].includes(clip.language) &&
    [clip.generation, clip.sequence].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    [
      clip.sourceStartAtUnixMs,
      clip.sourceEndAtUnixMs,
      clip.publishedAtUnixMs,
      clip.durationMs,
      clip.byteLength,
    ].every(Number.isFinite) &&
    clip.sourceStartAtUnixMs > 0 &&
    clip.sourceEndAtUnixMs >= clip.sourceStartAtUnixMs &&
    clip.durationMs > 0 &&
    clip.durationMs <= 120_000 &&
    clip.byteLength > 44 &&
    clip.byteLength <= 24 * 1024 * 1024
  );
}

export function updateAudioWindow(current: AudioWindow, service: PublicServiceState): AudioWindow {
  if (!service.active || !service.sessionId) return emptyAudioWindow();
  const old = current.sessionId === service.sessionId ? current : emptyAudioWindow();
  const generations: Record<string, number> = {};
  for (const channel of service.languages) {
    if (
      channel.bufferedAudioAvailable &&
      channel.channelId &&
      Number.isSafeInteger(channel.audioGeneration)
    )
      generations[channel.channelId] = Math.max(
        channel.audioGeneration!,
        old.generations[channel.channelId] ?? 0,
      );
  }
  return {
    sessionId: service.sessionId,
    generations,
    clips: old.clips.filter((clip) => generations[clip.channelId] === clip.generation),
  };
}
export function appendAudioClip(current: AudioWindow, clip: BufferedAudioClip): AudioWindow {
  if (
    !validAudioClip(clip) ||
    clip.sessionId !== current.sessionId ||
    current.generations[clip.channelId] !== clip.generation
  )
    return current;
  return {
    ...current,
    clips: [
      ...current.clips.filter(
        (item) => item.id !== clip.id && item.publishedAtUnixMs >= clip.publishedAtUnixMs - 240_000,
      ),
      clip,
    ].slice(-512),
  };
}
export function clearAudioWindow(
  current: AudioWindow,
  sessionId: string,
  channelId: string,
  generation: number,
): AudioWindow {
  if (
    sessionId !== current.sessionId ||
    !Number.isSafeInteger(generation) ||
    generation < (current.generations[channelId] ?? 0)
  )
    return current;
  return {
    ...current,
    generations: { ...current.generations, [channelId]: generation },
    clips: current.clips.filter((clip) => clip.channelId !== channelId),
  };
}
