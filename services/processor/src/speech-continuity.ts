import type { CaptionWordTiming, RenderedSpeech } from '@multilinguum/protocol';

const frameSamples = 480;
const silenceRms = 72;
const leadingRoomSamples = frameSamples * 4;
const fadeSamples = frameSamples;

function frameRms(samples: Int16Array, start: number, end: number): number {
  let energy = 0;
  for (let index = start; index < end; index += 1) {
    const value = samples[index] ?? 0;
    energy += value * value;
  }
  return Math.sqrt(energy / Math.max(1, end - start));
}

/**
 * Removes only the long synthetic padding commonly returned around separate
 * TTS calls. It retains 40 ms before speech and 100 ms after it, then applies a
 * short edge fade so adjacent queued clauses remain continuous without clicks.
 * Spoken audio is never overlapped with the next clause.
 */
export function preservedTrailingPauseMs(sourcePauseAfterMs?: number): number {
  if (sourcePauseAfterMs === undefined) return 100;
  return Math.max(100, Math.min(550, Math.round(sourcePauseAfterMs * 0.75)));
}

export function prepareSpeechForContinuousPlayout(
  chunk: RenderedSpeech,
  sourcePauseAfterMs?: number,
): RenderedSpeech {
  if (
    chunk.encoding !== 'pcm_s16le' ||
    chunk.sampleRate !== 48_000 ||
    chunk.data.byteLength < frameSamples * 2 * 4
  ) {
    return chunk;
  }
  const aligned = new Uint8Array(chunk.data.byteLength);
  aligned.set(chunk.data);
  const samples = new Int16Array(aligned.buffer);
  let firstActive = -1;
  let lastActive = -1;
  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    if (frameRms(samples, start, end) < silenceRms) continue;
    if (firstActive < 0) firstActive = start;
    lastActive = end;
  }
  if (firstActive < 0 || lastActive < 0) return chunk;
  const start = Math.max(0, firstActive - leadingRoomSamples);
  const trailingRoomSamples = Math.round(
    (preservedTrailingPauseMs(sourcePauseAfterMs) / 1_000) * chunk.sampleRate,
  );
  const desiredEnd = lastActive + trailingRoomSamples;
  const end = Math.min(samples.length, desiredEnd);
  if (start === 0 && end === samples.length && desiredEnd <= samples.length) return chunk;
  const sliced = samples.slice(start, end);
  let output = sliced;
  if (desiredEnd > samples.length) {
    output = new Int16Array(sliced.length + desiredEnd - samples.length);
    output.set(sliced);
  }
  const edge = Math.min(fadeSamples, Math.floor(output.length / 4));
  for (let index = 0; index < edge; index += 1) {
    const gain = (index + 1) / edge;
    output[index] = Math.round((output[index] ?? 0) * gain);
    const tail = output.length - 1 - index;
    output[tail] = Math.round((output[tail] ?? 0) * gain);
  }
  return { ...chunk, data: new Uint8Array(output.buffer) };
}

export function speechDurationMs(chunk: RenderedSpeech): number {
  if (chunk.encoding !== 'pcm_s16le' || chunk.sampleRate <= 0) return 0;
  return Math.round((chunk.data.byteLength / 2 / chunk.sampleRate) * 1_000);
}

export function estimateSpeechDurationMs(text: string): number {
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  return Math.max(750, Math.round((words / 2.45) * 1_000));
}

/**
 * TTS PCM does not include word alignment, so distribute the measured spoken
 * duration using word length and punctuation. The browser uses these bounded
 * estimates only for the karaoke affordance; transcript text remains exact.
 */
export function buildCaptionWordTimings(
  text: string,
  spokenDurationMs: number,
): CaptionWordTiming[] {
  const words = text.trim().match(/\S+/gu) ?? [];
  if (words.length === 0) return [];
  const weights = words.map((word) => {
    const letters = word.replace(/[^\p{L}\p{N}]/gu, '').length;
    const punctuation = /[.!?…]["'»”)]*$/u.test(word)
      ? 0.65
      : /[,;:—–-]["'»”)]*$/u.test(word)
        ? 0.28
        : 0;
    return Math.max(0.75, 0.68 + letters * 0.095 + punctuation);
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return words.map((word, index) => {
    const startOffsetMs = Math.round(cursor);
    cursor += (spokenDurationMs * (weights[index] ?? 1)) / totalWeight;
    return {
      text: word,
      startOffsetMs,
      endOffsetMs: Math.max(startOffsetMs + 1, Math.round(cursor)),
    };
  });
}
