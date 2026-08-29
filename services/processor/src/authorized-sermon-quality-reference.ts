import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import OpenAI, { toFile } from 'openai';

const execFileAsync = promisify(execFile);
const apiKey = process.env.OPENAI_API_KEY;
const audioPath = process.env.AUTHORIZED_AUDIO_PATH;
const expectedSha256 = process.env.AUTHORIZED_AUDIO_SHA256;
const voiceWorkerUrl = process.env.VOICE_WORKER_URL;
const voiceWorkerToken = process.env.VOICE_WORKER_TOKEN;
const profileId = process.env.VOICE_PROFILE_ID;
const transcriptionModel = process.env.OPENAI_FILE_TRANSCRIBE_MODEL ?? 'gpt-transcribe';
const translationModel = process.env.OPENAI_TEXT_MODEL ?? 'gpt-5.6-terra';
const outputDirectory = process.env.QUALITY_REFERENCE_OUTPUT_DIR ?? '/tmp/multilinguum-quality';

if (!apiKey) throw new Error('OPENAI_API_KEY is required.');
if (!audioPath) throw new Error('AUTHORIZED_AUDIO_PATH is required.');
if (!expectedSha256) throw new Error('AUTHORIZED_AUDIO_SHA256 is required.');
if (!voiceWorkerUrl || !voiceWorkerToken)
  throw new Error('Voice worker configuration is required.');
if (!profileId) throw new Error('VOICE_PROFILE_ID is required.');

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function pcmDataFromWav(input: Buffer): Buffer {
  if (input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Authorized fixture is not a WAV file.');
  }
  let compatible = false;
  let data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= input.byteLength;) {
    const id = input.toString('ascii', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > input.byteLength) throw new Error(`WAV chunk ${id} exceeds the fixture size.`);
    if (id === 'fmt ' && size >= 16) {
      compatible =
        input.readUInt16LE(start) === 1 &&
        input.readUInt16LE(start + 2) === 1 &&
        input.readUInt32LE(start + 4) === 48_000 &&
        input.readUInt16LE(start + 14) === 16;
    }
    if (id === 'data') data = input.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!compatible || !data) throw new Error('Fixture must be 48 kHz mono signed 16-bit PCM.');
  return data;
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

const fixture = await readFile(audioPath);
const fixtureSha256 = sha256(fixture);
if (fixtureSha256 !== expectedSha256) {
  throw new Error(
    `Authorized fixture hash mismatch: expected ${expectedSha256}, got ${fixtureSha256}.`,
  );
}
const sourcePcm = pcmDataFromWav(fixture);
const sourceDurationMs = Math.round((sourcePcm.byteLength / 2 / 48_000) * 1_000);
if (sourceDurationMs !== 45_000)
  throw new Error(`Expected 45 seconds; got ${sourceDurationMs} ms.`);

const client = new OpenAI({ apiKey });
const transcriptionStartedAt = Date.now();
const transcriptResponse = await client.audio.transcriptions.create({
  file: await toFile(fixture, 'authorized-sermon-ru-45s.wav', { type: 'audio/wav' }),
  model: transcriptionModel,
  language: 'ru',
  prompt:
    'Русская церковная проповедь о Божьем стандарте истины, первых людях, системе ценностей, ' +
    'рабстве похоти, вражде, семье, обществе, церкви, мире и природе.',
  response_format: 'json',
});
const transcriptionCompletedAt = Date.now();
const sourceTranscript = transcriptResponse.text.trim();
if (!sourceTranscript) throw new Error('The high-accuracy transcription was empty.');

const translationStartedAt = Date.now();
const translationResponse = await client.responses.create({
  model: translationModel,
  instructions:
    'Translate this Russian church-sermon excerpt faithfully into idiomatic English. Preserve ' +
    'theological meaning, causal relationships, sentence boundaries, and rhetorical emphasis. ' +
    'Do not add, omit, summarize, explain, or strengthen any claim. Return only the translation.',
  input: [
    'Terminology:',
    'Божий стандарт истины => God’s standard of truth',
    'без Божьего стандарта истины => without God’s standard of truth',
    'первые люди => the first humans',
    'система ценностей => value system',
    'рабство похоти => slavery to lust',
    'вражда => hostility',
    'церковь => church',
    '',
    `Translate:\n${sourceTranscript}`,
  ].join('\n'),
});
const translationCompletedAt = Date.now();
const englishTranslation = translationResponse.output_text.trim();
if (!englishTranslation) throw new Error('The glossary-aware translation was empty.');
if (englishTranslation.length > 1_200)
  throw new Error('Translation exceeds the voice-worker limit.');

const renderStartedAt = Date.now();
const sentences =
  englishTranslation.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()) ?? [];
if (sentences.length === 0 || sentences.join(' ') !== englishTranslation) {
  throw new Error('Could not split the translation into complete render sentences.');
}
const renderedChunks: Buffer[] = [];
const renderChunks: Array<{
  sequence: number;
  text: string;
  renderMs: number;
  durationMs: number;
}> = [];
const pause = Buffer.alloc(Math.round(48_000 * 2 * 0.25));
for (const [sequence, sentence] of sentences.entries()) {
  const chunkStartedAt = Date.now();
  const response = await fetch(new URL('/v1/render', voiceWorkerUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${voiceWorkerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text: sentence,
      language: 'en',
      profileId,
      sourceStartMs: Math.round((sourceDurationMs * sequence) / sentences.length),
      sourceEndMs: Math.round((sourceDurationMs * (sequence + 1)) / sentences.length),
      sequence,
      exaggeration: 0.5,
      // The reference is Russian while the requested output is English. Chatterbox's
      // documented cross-language mitigation is CFG 0 to reduce accent transfer.
      cfgWeight: 0,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Voice worker failed with ${response.status}: ${await response.text()}`);
  }
  if (response.headers.get('x-renderer') !== 'chatterbox-multilingual-v3') {
    throw new Error('Voice worker did not return the required cloned renderer.');
  }
  const chunk = Buffer.from(await response.arrayBuffer());
  if (chunk.byteLength === 0)
    throw new Error(`Voice worker returned empty audio for sentence ${sequence}.`);
  renderedChunks.push(chunk);
  if (sequence < sentences.length - 1) renderedChunks.push(pause);
  renderChunks.push({
    sequence,
    text: sentence,
    renderMs: Date.now() - chunkStartedAt,
    durationMs: Math.round((chunk.byteLength / 2 / 48_000) * 1_000),
  });
}
const renderedPcm = Buffer.concat(renderedChunks);
const renderCompletedAt = Date.now();

await mkdir(outputDirectory, { recursive: true });
const rawWavPath = join(outputDirectory, 'translated-en-cloned-raw.wav');
const wavPath = join(outputDirectory, 'translated-en-cloned.wav');
const opusPath = join(outputDirectory, 'translated-en-cloned.opus');
await Promise.all([
  writeFile(join(outputDirectory, 'source-ru.wav'), fixture, { mode: 0o600 }),
  writeFile(rawWavPath, wavFromPcmMono(renderedPcm, 48_000), { mode: 0o600 }),
]);
await execFileAsync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-i',
  rawWavPath,
  '-af',
  'loudnorm=I=-16:TP=-1.5:LRA=7',
  '-ar',
  '48000',
  '-ac',
  '1',
  '-c:a',
  'pcm_s16le',
  wavPath,
]);
await unlink(rawWavPath);
await execFileAsync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-i',
  wavPath,
  '-c:a',
  'libopus',
  '-b:a',
  '48k',
  opusPath,
]);
const renderedWav = await readFile(wavPath);
const renderedOpus = await readFile(opusPath);
const renderedDurationMs = Math.round(
  (pcmDataFromWav(renderedWav).byteLength / 2 / 48_000) * 1_000,
);

const report = {
  generatedAt: new Date().toISOString(),
  privacy: 'authorized preacher sermon excerpt; private non-sharing production project',
  fixture: { sha256: fixtureSha256, sourceDurationMs },
  models: {
    transcription: transcriptionModel,
    translation: translationModel,
    speechRenderer: 'chatterbox-multilingual-v3',
  },
  timing: {
    transcriptionMs: transcriptionCompletedAt - transcriptionStartedAt,
    translationMs: translationCompletedAt - translationStartedAt,
    clonedRenderMs: renderCompletedAt - renderStartedAt,
    totalAfterFileReadyMs: renderCompletedAt - transcriptionStartedAt,
    renderedDurationMs,
    renderChunks,
  },
  text: { sourceTranscript, englishTranslation },
  translationUsage: translationResponse.usage,
  artifacts: {
    sourceWav: { sha256: fixtureSha256, bytes: fixture.byteLength },
    translatedWav: { sha256: sha256(renderedWav), bytes: renderedWav.byteLength },
    translatedOpus: { sha256: sha256(renderedOpus), bytes: renderedOpus.byteLength },
  },
};
await writeFile(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
