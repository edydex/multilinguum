import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const baseUrl = process.env.PROCESSOR_PUBLIC_URL ?? 'http://127.0.0.1:4310';
const token = process.env.PROCESSOR_CONTROL_TOKEN ?? 'development-control-token-change-me-now';
const profileId = process.env.VOICE_PROFILE_ID;
if (!profileId) throw new Error('VOICE_PROFILE_ID is required.');

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/replay.ru.json', import.meta.url), 'utf8'),
);

async function request(path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

const session = await request('/api/sessions', {
  sourceLanguage: 'ru',
  targets: [
    {
      id: 'channel-ru',
      targetLanguage: 'ru',
      translationProvider: 'deterministic',
      voiceMode: 'source',
      fallbackOrder: ['mute'],
      muted: false,
    },
    {
      id: 'channel-en',
      targetLanguage: 'en',
      translationProvider: 'deterministic',
      voiceMode: 'cloned',
      voiceProfileId: profileId,
      fallbackOrder: ['natural', 'mute'],
      muted: false,
    },
  ],
  processingNode: {
    id: 'fixture',
    name: 'Fixture runner',
    mode: 'remote',
    endpoint: baseUrl,
    identityFingerprint: 'fixture-development-identity',
  },
  archivePolicy: {
    retentionDays: 30,
    retainIndefinitely: false,
    recordSource: true,
    recordTranslations: true,
  },
  expectedDurationMinutes: 2,
  budgetWarningUsd: 20,
});

await request('/api/sessions/current/start', {});
const started = performance.now();
const replay = await request('/api/sessions/current/replay', {
  segments: [fixture.segments[0]],
});
const renderElapsedMs = Math.round(performance.now() - started);
const current = await request('/api/sessions/current');
const stopped = await request('/api/sessions/current/stop', {});

console.log(
  JSON.stringify(
    {
      sessionId: session.id,
      translations: replay.translated.length,
      renderElapsedMs,
      channelHealth: current.health,
      archive: stopped.archive,
    },
    null,
    2,
  ),
);
