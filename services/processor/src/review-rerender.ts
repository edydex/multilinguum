import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PipelineLatencySample, TranscriptSegment } from '@multilinguum/protocol';
import { SermonContextStore } from './context-store.js';
import { defaultGlossary } from './glossary.js';
import {
  OpenAINaturalSpeechRenderer,
  OpenAITextTranslationProvider,
  strengthenEnglishParallelFocusPlan,
} from './providers/openai-cascade.js';
import {
  buildCaptionWordTimings,
  prepareSpeechForContinuousPlayout,
  speechDurationMs,
  targetLeadingPauseMs,
  targetTrailingPauseMs,
} from './speech-continuity.js';

const execFileAsync = promisify(execFile);

const apiKey = process.env.OPENAI_API_KEY;
const rawSourcePath = process.env.REVIEW_RAW_SOURCE_TRANSCRIPT_PATH;
const priorTranslationPath = process.env.REVIEW_PRIOR_TRANSLATION_PATH;
const outputDirectory = process.env.REVIEW_OUTPUT_DIR;
const outputVersion = process.env.REVIEW_OUTPUT_VERSION ?? 'v2';
const cachedTranslationPath = process.env.REVIEW_CACHED_TRANSLATION_PATH;
const archiveRoot = process.env.ARCHIVE_ROOT ?? './data/archives';
const contextDocumentIds = (process.env.REVIEW_CONTEXT_DOCUMENT_IDS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const translationModel = process.env.OPENAI_TEXT_MODEL ?? 'gpt-5.6-terra';
const ttsModel = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';

if (!apiKey) throw new Error('OPENAI_API_KEY is required.');
if (!rawSourcePath) throw new Error('REVIEW_RAW_SOURCE_TRANSCRIPT_PATH is required.');
if (!priorTranslationPath) throw new Error('REVIEW_PRIOR_TRANSLATION_PATH is required.');
if (!outputDirectory) throw new Error('REVIEW_OUTPUT_DIR is required.');
if (!/^[a-z0-9-]{1,24}$/u.test(outputVersion)) {
  throw new Error('REVIEW_OUTPUT_VERSION must contain only lowercase letters, digits, or hyphens.');
}

function parseJsonl<T>(contents: string): T[] {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function jsonl(values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function wavFromPcmMono(pcm: Uint8Array, sampleRate: number): Buffer {
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
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/**
 * Reconstructs the exact semantic windows from an earlier archive while using
 * the source-language captions as the translation input. This is intentionally
 * separate from the live pipeline: it lets a reviewer compare narration
 * changes without buying another transcription pass or changing the source.
 */
export function buildReviewSourceSegments(
  rawSource: readonly TranscriptSegment[],
  priorTranslation: readonly TranscriptSegment[],
  sessionId: string,
): TranscriptSegment[] {
  const finalSource = rawSource.filter((segment) => segment.final);
  return priorTranslation
    .filter((segment) => segment.final)
    .sort((left, right) => left.sequence - right.sequence)
    .map((template) => {
      const overlapping = finalSource.filter(
        (segment) =>
          segment.sourceStartMs < template.sourceEndMs &&
          segment.sourceEndMs > template.sourceStartMs,
      );
      const text = overlapping
        .map((segment) => segment.text.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
      if (!text) {
        throw new Error(`No source transcript overlaps review segment ${template.sequence}.`);
      }
      return {
        id: randomUUID(),
        sessionId,
        channelId: 'source-ru',
        language: 'ru',
        text,
        sourceStartMs: template.sourceStartMs,
        sourceEndMs: template.sourceEndMs,
        emittedAt: new Date().toISOString(),
        final: true,
        sequence: template.sequence,
        ...(template.sourcePauseAfterMs !== undefined
          ? { sourcePauseAfterMs: template.sourcePauseAfterMs }
          : {}),
        ...(template.sourceDelivery ? { sourceDelivery: template.sourceDelivery } : {}),
      } satisfies TranscriptSegment;
    });
}

const [rawSourceText, priorTranslationText] = await Promise.all([
  readFile(path.resolve(rawSourcePath), 'utf8'),
  readFile(path.resolve(priorTranslationPath), 'utf8'),
]);
const priorTranslation = parseJsonl<TranscriptSegment>(priorTranslationText);
const cachedTranslations = cachedTranslationPath
  ? new Map(
      parseJsonl<TranscriptSegment>(await readFile(path.resolve(cachedTranslationPath), 'utf8'))
        .filter((segment) => segment.final)
        .map((segment) => [segment.sequence, segment]),
    )
  : undefined;
const sessionId = `review-rerender-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
const sources = buildReviewSourceSegments(
  parseJsonl<TranscriptSegment>(rawSourceText),
  priorTranslation,
  sessionId,
);

const context = new SermonContextStore(archiveRoot);
await context.require(contextDocumentIds);
const translator = new OpenAITextTranslationProvider(apiKey, translationModel);
const renderer = new OpenAINaturalSpeechRenderer(apiKey, ttsModel);
const precedingText: string[] = [];
const translatedSegments: TranscriptSegment[] = [];
const latencySamples: PipelineLatencySample[] = [];
const audioChunks: Uint8Array[] = [];
const programOriginUnixMs = Date.now();
let audioCursorMs = 0;

for (const [index, source] of sources.entries()) {
  const followingText = sources[index + 1]?.text;
  const translationStartedAtUnixMs = Date.now();
  const cached = cachedTranslations?.get(source.sequence);
  const translated = cached
    ? {
        ...cached,
        narrationPlan: cached.narrationPlan
          ? strengthenEnglishParallelFocusPlan(cached.text, precedingText, cached.narrationPlan)
          : undefined,
      }
    : await translator.translate(source, {
        sourceLanguage: 'ru',
        targetLanguage: 'en',
        glossary: defaultGlossary.en,
        precedingText,
        ...(followingText ? { followingText } : {}),
        sermonNotes: await context.retrieve(contextDocumentIds, source.text),
      });
  const translationCompletedAtUnixMs = Date.now();
  const finalized: TranscriptSegment = {
    ...translated,
    sessionId,
    channelId: 'channel-en',
    final: true,
    emittedAt: new Date().toISOString(),
  };
  precedingText.push(finalized.text);
  if (precedingText.length > 8) precedingText.shift();

  const renderStartedAtUnixMs = Date.now();
  const rawSpeech = await renderer.render(finalized, undefined, {
    playbackBacklogMs: 0,
    sourceDelivery: source.sourceDelivery,
  });
  const speech = prepareSpeechForContinuousPlayout(
    rawSpeech,
    targetTrailingPauseMs(finalized.narrationPlan, source.sourcePauseAfterMs),
    targetLeadingPauseMs(finalized.narrationPlan),
  );
  const renderCompletedAtUnixMs = Date.now();
  const durationMs = speechDurationMs(speech);
  if (durationMs <= 0) throw new Error(`Speech renderer returned no audio for ${source.sequence}.`);

  const playoutStartedAtUnixMs = programOriginUnixMs + audioCursorMs;
  const playoutCompletedAtUnixMs = playoutStartedAtUnixMs + durationMs;
  finalized.playout = {
    startAtUnixMs: playoutStartedAtUnixMs,
    endAtUnixMs: playoutCompletedAtUnixMs,
    words: buildCaptionWordTimings(finalized.text, durationMs),
  };
  translatedSegments.push(finalized);
  audioChunks.push(speech.data);
  latencySamples.push({
    id: randomUUID(),
    sessionId,
    channelId: 'channel-en',
    language: 'en',
    sequence: source.sequence,
    sourceStartMs: source.sourceStartMs,
    sourceEndMs: source.sourceEndMs,
    recordedAt: new Date().toISOString(),
    translation: {
      startedAtUnixMs: translationStartedAtUnixMs,
      completedAtUnixMs: translationCompletedAtUnixMs,
    },
    speechRender: {
      startedAtUnixMs: renderStartedAtUnixMs,
      completedAtUnixMs: renderCompletedAtUnixMs,
    },
    playout: {
      startedAtUnixMs: playoutStartedAtUnixMs,
      completedAtUnixMs: playoutCompletedAtUnixMs,
    },
    metrics: {
      chunkWindowMs: source.sourceEndMs - source.sourceStartMs,
      translationMs: translationCompletedAtUnixMs - translationStartedAtUnixMs,
      speechRenderMs: renderCompletedAtUnixMs - renderStartedAtUnixMs,
      playoutQueueMs: audioCursorMs,
    },
    engines: {
      translation: cached ? `${translator.name}:cached` : translator.name,
      speechRenderer: renderer.name,
      relay: 'offline-review',
    },
    outcome: 'complete',
  });
  audioCursorMs += durationMs;
  process.stderr.write(`Rendered ${index + 1}/${sources.length}\n`);
}

const outputRoot = path.resolve(outputDirectory);
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const pcm = Buffer.concat(audioChunks.map((chunk) => Buffer.from(chunk)));
const wav = wavFromPcmMono(pcm, 48_000);
const outputBase = `translated-en-${outputVersion}`;
const wavPath = path.join(outputRoot, `${outputBase}.wav`);
const mp3Path = path.join(outputRoot, `${outputBase}.mp3`);
const opusPath = path.join(outputRoot, `${outputBase}.opus`);
await Promise.all([
  writeFile(wavPath, wav, { mode: 0o600 }),
  writeFile(path.join(outputRoot, `${outputBase}.jsonl`), jsonl(translatedSegments), {
    mode: 0o600,
  }),
  writeFile(
    path.join(outputRoot, `review-source-segments-${outputVersion}.jsonl`),
    jsonl(sources),
    {
      mode: 0o600,
    },
  ),
  writeFile(path.join(outputRoot, `latency-${outputVersion}.jsonl`), jsonl(latencySamples), {
    mode: 0o600,
  }),
]);
await Promise.all([
  execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    wavPath,
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '2',
    mp3Path,
  ]),
  execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    wavPath,
    '-codec:a',
    'libopus',
    '-b:a',
    '48k',
    opusPath,
  ]),
]);
const [mp3, opus] = await Promise.all([readFile(mp3Path), readFile(opusPath)]);
const report = {
  generatedAt: new Date().toISOString(),
  privacy: 'authorized sermon archive; private non-sharing production project',
  sessionId,
  models: { translation: translationModel, speechRenderer: ttsModel, voice: 'cedar' },
  inputs: {
    sourceTranscript: path.basename(rawSourcePath),
    priorSegmentation: path.basename(priorTranslationPath),
    contextDocumentIds,
    cachedTranslation: cachedTranslationPath ? path.basename(cachedTranslationPath) : null,
  },
  output: {
    segmentCount: translatedSegments.length,
    durationMs: audioCursorMs,
    mp3: { bytes: mp3.byteLength, sha256: sha256(mp3) },
    opus: { bytes: opus.byteLength, sha256: sha256(opus) },
  },
};
await writeFile(
  path.join(outputRoot, `result-${outputVersion}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
await rm(wavPath, { force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
