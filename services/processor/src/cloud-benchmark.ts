import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import WebSocket, { type RawData } from 'ws';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is required.');

const outputDirectory = process.env.BENCHMARK_OUTPUT_DIR ?? '/tmp/multilinguum-cloud-benchmark';
const translationModel = process.env.OPENAI_TRANSLATE_MODEL ?? 'gpt-realtime-translate';
const transcriptionModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-live-transcribe';
const ttsModel = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
const targetLanguage = process.env.BENCHMARK_TARGET_LANGUAGE ?? 'en';
const safetyIdentifier = 'multilinguum-synthetic-benchmark';

const sourceText =
  'Благодать вам и мир. Сегодня мы будем размышлять о надежде, которая не зависит от ' +
  'переменчивых обстоятельств. Когда человек испытывает страх или усталость, ему особенно ' +
  'важно помнить: Божья верность не ослабевает. Откроем Писание и внимательно рассмотрим ' +
  'слова о милости, истине и прощении. Эти слова учат нас честно видеть нужду, поддерживать ' +
  'друг друга и с терпением совершать добро. Пусть наша речь будет ясной, наши решения ' +
  'мудрыми, а любовь деятельной. Если мы ошиблись, будем готовы признать это, исправить путь ' +
  'и снова искать мира. Господь укрепляет тех, кто уповает на Него. Поэтому не будем унывать, ' +
  'но продолжим служить с благодарностью и надеждой.';

type RealtimeEvent = Record<string, unknown> & { type?: string };

interface TimingState {
  firstDeltaAt?: number;
  completedAt?: number;
  transcript: string;
}

interface AlignedTimingState {
  arrivalLagMs: number[];
  firstFrameElapsedMs?: number;
}

class RealtimeConnection {
  readonly socket: WebSocket;
  readonly eventCounts = new Map<string, number>();
  readonly #waiters = new Map<string, Array<(event: RealtimeEvent) => void>>();
  readonly #onEvent: (event: RealtimeEvent) => void;

  constructor(url: string, onEvent: (event: RealtimeEvent) => void, bearerToken = apiKey) {
    this.#onEvent = onEvent;
    this.socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'OpenAI-Safety-Identifier': safetyIdentifier,
      },
    });
    this.socket.on('message', (data: RawData) => {
      const event = JSON.parse(data.toString()) as RealtimeEvent;
      const type = event.type ?? 'unknown';
      this.eventCounts.set(type, (this.eventCounts.get(type) ?? 0) + 1);
      if (type === 'error') {
        const detail = JSON.stringify(event.error ?? event);
        process.stderr.write(`Realtime API error: ${detail}\n`);
      }
      this.#onEvent(event);
      const waiter = this.#waiters.get(type)?.shift();
      if (waiter) waiter(event);
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out opening Realtime socket.')),
        15_000,
      );
      this.socket.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  waitFor(type: string, timeoutMs = 30_000): Promise<RealtimeEvent> {
    return new Promise((resolve, reject) => {
      const complete = (event: RealtimeEvent) => {
        clearTimeout(timeout);
        resolve(event);
      };
      const timeout = setTimeout(() => {
        const waiters = this.#waiters.get(type) ?? [];
        this.#waiters.set(
          type,
          waiters.filter((waiter) => waiter !== complete),
        );
        reject(new Error(`Timed out waiting for ${type}.`));
      }, timeoutMs);
      this.#waiters.set(type, [...(this.#waiters.get(type) ?? []), complete]);
    });
  }

  send(event: unknown): void {
    this.socket.send(JSON.stringify(event));
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

function appendDelta(state: TimingState, event: RealtimeEvent, now: number): void {
  if (state.firstDeltaAt === undefined) state.firstDeltaAt = now;
  if (typeof event.delta === 'string') state.transcript += event.delta;
}

function wavFromPcmMono(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function recordAlignment(
  state: AlignedTimingState,
  event: RealtimeEvent,
  now: number,
  streamStartedAt: number,
): void {
  if (streamStartedAt === 0 || typeof event.elapsed_ms !== 'number') return;
  if (state.firstFrameElapsedMs === undefined) state.firstFrameElapsedMs = event.elapsed_ms;
  state.arrivalLagMs.push(now - streamStartedAt - event.elapsed_ms);
}

function percentile(values: readonly number[], quantile: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function alignmentSummary(state: AlignedTimingState) {
  return {
    samples: state.arrivalLagMs.length,
    firstFrameElapsedMs: state.firstFrameElapsedMs,
    arrivalLagP50Ms: percentile(state.arrivalLagMs, 0.5),
    arrivalLagP95Ms: percentile(state.arrivalLagMs, 0.95),
  };
}

function trailingSilenceMs(pcm: Buffer, sampleRate: number): number {
  const threshold = 184; // Approximately -45 dBFS for signed 16-bit PCM.
  for (let offset = pcm.byteLength - 2; offset >= 0; offset -= 2) {
    if (Math.abs(pcm.readInt16LE(offset)) > threshold) {
      return Math.round(((pcm.byteLength - offset - 2) / 2 / sampleRate) * 1_000);
    }
  }
  return Math.round((pcm.byteLength / 2 / sampleRate) * 1_000);
}

function elapsed(startedAt: number, instant?: number): number | undefined {
  return instant === undefined ? undefined : instant - startedAt;
}

function sortedCounts(connection: RealtimeConnection): Record<string, number> {
  return Object.fromEntries(
    [...connection.eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

const client = new OpenAI({ apiKey });
const synthesisStartedAt = Date.now();
const sourceResponse = await client.audio.speech.create({
  model: ttsModel,
  voice: 'cedar',
  input: sourceText,
  response_format: 'pcm',
  instructions:
    'Speak in clear, natural Russian at a measured sermon pace. Do not translate the text.',
});
const sourcePcm = Buffer.from(await sourceResponse.arrayBuffer());
const synthesisCompletedAt = Date.now();
const sourceDurationMs = Math.round((sourcePcm.byteLength / 2 / 24_000) * 1_000);
if (sourceDurationMs < 10_000) throw new Error('Synthetic source audio is unexpectedly short.');
const transcriptionClientSecret = await client.realtime.clientSecrets.create({
  expires_after: { anchor: 'created_at', seconds: 600 },
  session: {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        transcription: {
          model: transcriptionModel,
          prompt: 'Русская церковная проповедь о благодати, надежде, Писании и Господе.',
          keywords: ['Благодать', 'Писание', 'Господь', 'надежда'],
          languages: ['ru'],
          delay: 'low',
        },
        turn_detection: null,
      },
    },
  },
});

const translationInput: TimingState = { transcript: '' };
const translationOutput: TimingState = { transcript: '' };
const liveTranscription: TimingState = { transcript: '' };
const translationInputAlignment: AlignedTimingState = { arrivalLagMs: [] };
const translationOutputAlignment: AlignedTimingState = { arrivalLagMs: [] };
const translationAudioAlignment: AlignedTimingState = { arrivalLagMs: [] };
const translatedAudioChunks: Buffer[] = [];
let firstTranslatedAudioAt: number | undefined;
let translationClosedAt: number | undefined;
let sourceStreamCompletedAt: number | undefined;
let streamStartedAt = 0;
let translatedSampleRate = 24_000;

const translation = new RealtimeConnection(
  `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(translationModel)}`,
  (event) => {
    const now = Date.now();
    if (event.type === 'session.input_transcript.delta') {
      appendDelta(translationInput, event, now);
      recordAlignment(translationInputAlignment, event, now, streamStartedAt);
    }
    if (event.type === 'session.output_transcript.delta') {
      appendDelta(translationOutput, event, now);
      recordAlignment(translationOutputAlignment, event, now, streamStartedAt);
    }
    if (event.type === 'session.output_audio.delta' && typeof event.delta === 'string') {
      if (firstTranslatedAudioAt === undefined) firstTranslatedAudioAt = now;
      if (typeof event.sample_rate === 'number') translatedSampleRate = event.sample_rate;
      recordAlignment(translationAudioAlignment, event, now, streamStartedAt);
      translatedAudioChunks.push(Buffer.from(event.delta, 'base64'));
    }
    if (event.type === 'session.closed') translationClosedAt = now;
  },
);
const transcription = new RealtimeConnection(
  'wss://api.openai.com/v1/realtime',
  (event) => {
    const now = Date.now();
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      appendDelta(liveTranscription, event, now);
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      liveTranscription.completedAt = now;
      if (typeof event.transcript === 'string') liveTranscription.transcript = event.transcript;
    }
  },
  transcriptionClientSecret.value,
);

await Promise.all([translation.open(), transcription.open()]);
const translationUpdated = translation.waitFor('session.updated');
translation.send({
  type: 'session.update',
  session: {
    audio: {
      input: { transcription: { model: transcriptionModel } },
      output: { language: targetLanguage },
    },
  },
});
await translationUpdated;

streamStartedAt = Date.now();
const bytesPer20Ms = 24_000 * 2 * 0.02;
for (let offset = 0; offset < sourcePcm.byteLength; offset += bytesPer20Ms) {
  const audio = sourcePcm
    .subarray(offset, Math.min(sourcePcm.byteLength, offset + bytesPer20Ms))
    .toString('base64');
  translation.send({ type: 'session.input_audio_buffer.append', audio });
  transcription.send({ type: 'input_audio_buffer.append', audio });
  const targetElapsed = Math.round(((offset + bytesPer20Ms) / 2 / 24_000) * 1_000);
  const remaining = targetElapsed - (Date.now() - streamStartedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
sourceStreamCompletedAt = Date.now();

const translationClosed = translation.waitFor('session.closed', 45_000);
const transcriptionCompleted = transcription.waitFor(
  'conversation.item.input_audio_transcription.completed',
  45_000,
);
translation.send({ type: 'session.close' });
transcription.send({ type: 'input_audio_buffer.commit' });
await Promise.all([translationClosed, transcriptionCompleted]);
transcription.close();

const translatedPcm = Buffer.concat(translatedAudioChunks);
const translatedDurationMs = Math.round(
  (translatedPcm.byteLength / 2 / translatedSampleRate) * 1_000,
);
const translatedTrailingSilenceMs = trailingSilenceMs(translatedPcm, translatedSampleRate);
const firstInputTranscriptMs = elapsed(streamStartedAt, translationInput.firstDeltaAt);
const firstOutputTranscriptMs = elapsed(streamStartedAt, translationOutput.firstDeltaAt);
const firstOutputAudioMs = elapsed(streamStartedAt, firstTranslatedAudioAt);
const firstLiveTranscriptMs = elapsed(streamStartedAt, liveTranscription.firstDeltaAt);
const sourceStreamMs = elapsed(streamStartedAt, sourceStreamCompletedAt) ?? sourceDurationMs;
const report = {
  generatedAt: new Date().toISOString(),
  fixture: {
    privacy: 'self-authored synthetic Russian speech; no preacher recording or voice profile',
    sourceText,
    sourceDurationMs,
    sourceBytes: sourcePcm.byteLength,
    generationModel: ttsModel,
    generationRequestMs: synthesisCompletedAt - synthesisStartedAt,
  },
  models: {
    translation: translationModel,
    transcription: transcriptionModel,
    sourceSpeechGeneration: ttsModel,
  },
  timing: {
    sourceStreamMs,
    firstLiveTranscriptDeltaMs: firstLiveTranscriptMs,
    liveTranscriptCompletedMs: elapsed(streamStartedAt, liveTranscription.completedAt),
    firstTranslationInputTranscriptDeltaMs: firstInputTranscriptMs,
    firstTranslationOutputTranscriptDeltaMs: firstOutputTranscriptMs,
    firstTranslationAudioDeltaMs: firstOutputAudioMs,
    translationTranscriptAddedDelayMs:
      firstInputTranscriptMs === undefined || firstOutputTranscriptMs === undefined
        ? undefined
        : firstOutputTranscriptMs - firstInputTranscriptMs,
    translationAudioAddedDelayMs:
      firstInputTranscriptMs === undefined || firstOutputAudioMs === undefined
        ? undefined
        : firstOutputAudioMs - firstInputTranscriptMs,
    translationDrainAfterSourceMs:
      sourceStreamCompletedAt === undefined || translationClosedAt === undefined
        ? undefined
        : translationClosedAt - sourceStreamCompletedAt,
    alignment: {
      translationInputTranscript: alignmentSummary(translationInputAlignment),
      translationOutputTranscript: alignmentSummary(translationOutputAlignment),
      translationAudio: alignmentSummary(translationAudioAlignment),
    },
  },
  output: {
    translatedDurationMs,
    translatedSampleRate,
    translatedTrailingSilenceMs,
    translatedAudibleEndMs: translatedDurationMs - translatedTrailingSilenceMs,
    translatedBytes: translatedPcm.byteLength,
    liveTranscript: liveTranscription.transcript.trim(),
    translationInputTranscript: translationInput.transcript.trim(),
    translationOutputTranscript: translationOutput.transcript.trim(),
  },
  events: {
    translation: sortedCounts(translation),
    transcription: sortedCounts(transcription),
  },
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, 'source-ru.wav'), wavFromPcmMono(sourcePcm, 24_000)),
  writeFile(
    join(outputDirectory, `translated-${targetLanguage}.wav`),
    wavFromPcmMono(translatedPcm, translatedSampleRate),
  ),
  writeFile(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  }),
]);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
