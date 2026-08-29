import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket, { type RawData } from 'ws';

const baseUrl = new URL(process.env.PROCESSOR_REHEARSAL_URL ?? 'http://127.0.0.1:4310');
const controlToken = process.env.PROCESSOR_CONTROL_TOKEN;
const audioPath = process.env.AUTHORIZED_AUDIO_PATH;
const expectedSha256 = process.env.AUTHORIZED_AUDIO_SHA256;
const requestedProfileId = process.env.VOICE_PROFILE_ID;
const outputDirectory = process.env.REHEARSAL_OUTPUT_DIR ?? '/tmp/multilinguum-rehearsal';
const maxDrainMs = Number(process.env.REHEARSAL_MAX_DRAIN_MS ?? 180_000);

if (!controlToken) throw new Error('PROCESSOR_CONTROL_TOKEN is required.');
if (!audioPath) throw new Error('AUTHORIZED_AUDIO_PATH is required.');
if (!expectedSha256) throw new Error('AUTHORIZED_AUDIO_SHA256 is required.');

interface VoiceProfileSummary {
  id: string;
  displayName: string;
  sampleSha256: string;
  supportedLanguages: string[];
  consent: { permittedLanguages: string[]; revokedAt?: string };
  status: string;
}

interface SessionSummary {
  id: string;
  startedAt?: string;
  estimatedCostUsd: number;
}

interface ProcessorEvent {
  type?: string;
  scope?: string;
  segment?: { channelId?: string; text?: string };
  sample?: {
    channelId?: string;
    outcome?: string;
    engines?: { speechRenderer?: string };
  };
  health?: { channelId?: string; state?: string; error?: string };
}

interface WavPcm {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationMs: number;
}

function parsePcmWav(input: Buffer): WavPcm {
  if (input.byteLength < 44 || input.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Authorized fixture is not a RIFF WAV file.');
  }
  if (input.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Authorized fixture has no WAVE header.');
  }
  let format:
    { audioFormat: number; channels: number; sampleRate: number; bits: number } | undefined;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= input.byteLength;) {
    const id = input.toString('ascii', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > input.byteLength) throw new Error(`WAV chunk ${id} exceeds the fixture size.`);
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: input.readUInt16LE(start),
        channels: input.readUInt16LE(start + 2),
        sampleRate: input.readUInt32LE(start + 4),
        bits: input.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') pcm = input.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!format || !pcm) throw new Error('Authorized fixture is missing WAV format or audio data.');
  if (
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 48_000 ||
    format.bits !== 16
  ) {
    throw new Error('Authorized fixture must be 48 kHz mono signed 16-bit PCM.');
  }
  return {
    pcm,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bits,
    durationMs: Math.round((pcm.byteLength / 2 / format.sampleRate) * 1_000),
  };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${controlToken}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(new URL(path, baseUrl), { ...init, headers });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}

async function requestJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}

async function openSocket(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out opening WebSocket.')), 15_000);
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function websocketUrl(path: string): URL {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const fixture = await readFile(audioPath);
const actualSha256 = createHash('sha256').update(fixture).digest('hex');
if (actualSha256 !== expectedSha256) {
  throw new Error(
    `Authorized fixture hash mismatch: expected ${expectedSha256}, got ${actualSha256}.`,
  );
}
const wav = parsePcmWav(fixture);
if (wav.durationMs !== 45_000) {
  throw new Error(`Authorized fixture must be exactly 45 seconds; got ${wav.durationMs} ms.`);
}

const profiles = await requestJson<VoiceProfileSummary[]>('/api/voice-profiles');
const profile = profiles.find((candidate) =>
  requestedProfileId
    ? candidate.id === requestedProfileId
    : candidate.sampleSha256 === actualSha256,
);
if (!profile) throw new Error('The consented voice profile for this fixture is not installed.');
if (
  profile.status !== 'ready' ||
  profile.consent.revokedAt ||
  !profile.supportedLanguages.includes('en') ||
  !profile.consent.permittedLanguages.includes('en')
) {
  throw new Error('The selected voice profile is not ready and consented for English output.');
}

const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const sourceChannelId = `actual-ru-${runId}`;
const englishChannelId = `actual-en-${runId}`;
const session = await requestJson<SessionSummary>('/api/sessions', {
  sourceLanguage: 'ru',
  targets: [
    {
      id: sourceChannelId,
      targetLanguage: 'ru',
      translationProvider: 'deterministic',
      voiceMode: 'source',
      fallbackOrder: ['mute'],
      muted: false,
    },
    {
      id: englishChannelId,
      targetLanguage: 'en',
      translationProvider: 'openai-cascade',
      voiceMode: 'cloned',
      voiceProfileId: profile.id,
      fallbackOrder: ['natural', 'mute'],
      muted: false,
    },
  ],
  processingNode: {
    id: 'vr-mayos-rehearsal',
    name: 'vr-mayos authorized rehearsal',
    mode: 'remote',
    endpoint: baseUrl.toString(),
    identityFingerprint: 'verified-video-redactor-gpu-237eaa1a965f4feaaf5c3a7686dc24d1',
  },
  archivePolicy: {
    retentionDays: 30,
    retainIndefinitely: false,
    recordSource: true,
    recordTranslations: true,
  },
  expectedDurationMinutes: wav.durationMs / 60_000,
  budgetWarningUsd: 20,
});
await requestJson('/api/sessions/current/start', {});

const events: Array<{ atUnixMs: number; event: ProcessorEvent }> = [];
let lastEventAt = Date.now();
const eventSocketUrl = websocketUrl('/api/operator/events');
eventSocketUrl.searchParams.set('token', controlToken);
const eventSocket = new WebSocket(eventSocketUrl);
eventSocket.on('message', (data: RawData) => {
  try {
    const event = JSON.parse(data.toString()) as ProcessorEvent;
    lastEventAt = Date.now();
    events.push({ atUnixMs: lastEventAt, event });
  } catch {
    // Ignore malformed diagnostics; the processor contract is evaluated from retained artifacts.
  }
});
await openSocket(eventSocket);

const captureUrl = websocketUrl('/api/capture/audio');
captureUrl.searchParams.set('token', controlToken);
captureUrl.searchParams.set('sessionId', session.id);
const captureSocket = new WebSocket(captureUrl);
await openSocket(captureSocket);

const streamStartedAtUnixMs = Date.now();
const streamStartedAt = performance.now();
const bytesPer20Ms = 48_000 * 2 * 0.02;
let sequence = 0;
for (let offset = 0; offset < wav.pcm.byteLength; offset += bytesPer20Ms) {
  const frame = wav.pcm.subarray(offset, Math.min(wav.pcm.byteLength, offset + bytesPer20Ms));
  const packet = Buffer.alloc(16 + frame.byteLength);
  packet.writeUInt32LE(sequence++, 0);
  packet.writeDoubleLE(Date.now(), 4);
  packet.writeUInt32LE(frame.byteLength / 2, 12);
  frame.copy(packet, 16);
  captureSocket.send(packet);
  const targetElapsedMs = Math.round(((offset + frame.byteLength) / 2 / 48_000) * 1_000);
  const remainingMs = targetElapsedMs - (performance.now() - streamStartedAt);
  if (remainingMs > 0) await sleep(remainingMs);
}
const streamCompletedAtUnixMs = Date.now();
captureSocket.close(1000, 'Authorized fixture completed');
await new Promise<void>((resolve) => captureSocket.once('close', () => resolve()));

const drainStartedAtUnixMs = Date.now();
let drainCompleted = false;
while (Date.now() - drainStartedAtUnixMs < maxDrainMs) {
  const sourceTranscripts = events.filter(
    ({ event }) => event.type === 'transcript' && event.segment?.channelId === sourceChannelId,
  ).length;
  const englishTranscripts = events.filter(
    ({ event }) => event.type === 'transcript' && event.segment?.channelId === englishChannelId,
  ).length;
  const englishLatency = events.filter(
    ({ event }) => event.type === 'latency' && event.sample?.channelId === englishChannelId,
  ).length;
  if (
    sourceTranscripts > 0 &&
    sourceTranscripts === englishTranscripts &&
    englishTranscripts === englishLatency &&
    Date.now() - lastEventAt >= 8_000
  ) {
    drainCompleted = true;
    break;
  }
  await sleep(500);
}
await sleep(1_000);

const current = await requestJson<{
  health: Array<{ channelId: string; state: string; engine: string; error?: string }>;
}>('/api/sessions/current');
const stopped = await requestJson<{ archive: Record<string, unknown> }>(
  '/api/sessions/current/stop',
  {},
);
eventSocket.close(1000, 'Rehearsal finalized');

await mkdir(outputDirectory, { recursive: true });
const artifacts = [
  { name: 'source-ru.opus', path: `/api/archives/${session.id}/audio/${sourceChannelId}` },
  {
    name: 'translated-en-cloned.opus',
    path: `/api/archives/${session.id}/audio/${englishChannelId}`,
  },
  { name: 'source-ru.jsonl', path: `/api/archives/${session.id}/transcripts/${sourceChannelId}` },
  {
    name: 'translated-en.jsonl',
    path: `/api/archives/${session.id}/transcripts/${englishChannelId}`,
  },
  { name: 'latency.jsonl', path: `/api/archives/${session.id}/latency` },
];
const artifactHashes: Record<string, { sha256: string; bytes: number }> = {};
for (const artifact of artifacts) {
  const contents = Buffer.from(await (await request(artifact.path)).arrayBuffer());
  await writeFile(join(outputDirectory, artifact.name), contents, { mode: 0o600 });
  artifactHashes[artifact.name] = {
    sha256: createHash('sha256').update(contents).digest('hex'),
    bytes: contents.byteLength,
  };
}

const sourceTranscriptEvents = events.filter(
  ({ event }) => event.type === 'transcript' && event.segment?.channelId === sourceChannelId,
);
const englishTranscriptEvents = events.filter(
  ({ event }) => event.type === 'transcript' && event.segment?.channelId === englishChannelId,
);
const englishLatencyEvents = events.filter(
  ({ event }) => event.type === 'latency' && event.sample?.channelId === englishChannelId,
);
const report = {
  generatedAt: new Date().toISOString(),
  fixture: {
    privacy: 'authorized preacher sermon excerpt; private production project',
    path: audioPath,
    sha256: actualSha256,
    durationMs: wav.durationMs,
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bitsPerSample: wav.bitsPerSample,
  },
  consent: {
    profileId: profile.id,
    profileName: profile.displayName,
    active: true,
    targetLanguage: 'en',
  },
  session: {
    id: session.id,
    sourceChannelId,
    englishChannelId,
    estimatedCostUsd: session.estimatedCostUsd,
  },
  timing: {
    streamStartedAtUnixMs,
    streamCompletedAtUnixMs,
    sourceStreamMs: streamCompletedAtUnixMs - streamStartedAtUnixMs,
    drainMs: Date.now() - drainStartedAtUnixMs,
    drainCompleted,
    firstSourceCaptionMs:
      sourceTranscriptEvents[0] === undefined
        ? undefined
        : sourceTranscriptEvents[0].atUnixMs - streamStartedAtUnixMs,
    firstEnglishCaptionMs:
      englishTranscriptEvents[0] === undefined
        ? undefined
        : englishTranscriptEvents[0].atUnixMs - streamStartedAtUnixMs,
  },
  counts: {
    sourceTranscripts: sourceTranscriptEvents.length,
    englishTranscripts: englishTranscriptEvents.length,
    englishLatencySamples: englishLatencyEvents.length,
    clonedLatencySamples: englishLatencyEvents.filter(
      ({ event }) => event.sample?.engines?.speechRenderer === 'chatterbox-multilingual-v3',
    ).length,
    failedEnglishSamples: englishLatencyEvents.filter(
      ({ event }) => event.sample?.outcome === 'failed',
    ).length,
  },
  health: current.health,
  archive: stopped.archive,
  artifacts: artifactHashes,
};
await writeFile(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!drainCompleted) throw new Error('Integrated pipeline did not drain within the time limit.');
if (
  report.counts.englishTranscripts === 0 ||
  report.counts.failedEnglishSamples > 0 ||
  report.counts.clonedLatencySamples !== report.counts.englishLatencySamples
) {
  throw new Error('The authorized cloned-voice rehearsal did not complete every English segment.');
}
