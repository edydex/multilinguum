import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const controlToken = 'test-control-token-with-at-least-32-characters';
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function testServer() {
  const root = await mkdtemp(path.join(tmpdir(), 'multilinguum-processor-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    PROCESSOR_CONTROL_TOKEN: controlToken,
    PROCESSOR_PUBLIC_URL: 'http://127.0.0.1:4310',
    ARCHIVE_ROOT: root,
  });
  const server = await buildServer(config);
  servers.push(server);
  return server;
}

function headers() {
  return { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' };
}

function sessionRequest() {
  return {
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
        voiceMode: 'natural',
        fallbackOrder: ['mute'],
        muted: false,
      },
      {
        id: 'channel-es',
        targetLanguage: 'es',
        translationProvider: 'deterministic',
        voiceMode: 'natural',
        fallbackOrder: ['mute'],
        muted: false,
      },
      {
        id: 'channel-uk',
        targetLanguage: 'uk',
        translationProvider: 'deterministic',
        voiceMode: 'natural',
        fallbackOrder: ['mute'],
        muted: false,
      },
    ],
    processingNode: {
      id: 'test-node',
      name: 'Test node',
      mode: 'embedded',
      endpoint: 'http://127.0.0.1:4310',
      identityFingerprint: 'test-identity-fingerprint',
    },
    archivePolicy: {
      retentionDays: 30,
      retainIndefinitely: false,
      recordSource: true,
      recordTranslations: true,
    },
    expectedDurationMinutes: 120,
    budgetWarningUsd: 20,
  };
}

describe('processor vertical slice', () => {
  it('locks, translates, isolates channel state, and finalizes an archive', async () => {
    const server = await testServer();
    const unauthorized = await server.inject({ method: 'GET', url: '/api/preflight' });
    expect(unauthorized.statusCode).toBe(401);

    const created = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: sessionRequest(),
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().estimatedCostUsd).toBe(0);
    const sessionId = created.json().id as string;

    const started = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/start',
      headers: headers(),
      payload: {},
    });
    expect(started.json().configurationLocked).toBe(true);

    const replay = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/replay',
      headers: headers(),
      payload: {
        segments: [
          {
            text: 'Благодать вам и мир от Бога Отца нашего.',
            sourceStartMs: 0,
            sourceEndMs: 2_700,
            final: true,
            sequence: 0,
          },
        ],
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().translated).toHaveLength(4);
    expect(
      replay.json().translated.find((item: { language: string }) => item.language === 'en').text,
    ).toBe('Grace to you and peace from God our Father.');

    const muted = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/channels/channel-es',
      headers: headers(),
      payload: { muted: true },
    });
    expect(muted.json().state).toBe('muted');

    const stopped = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/stop',
      headers: headers(),
      payload: {},
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().archive.integritySha256).toMatch(/^[a-f0-9]{64}$/);

    const archives = await server.inject({
      method: 'GET',
      url: '/api/archives',
      headers: headers(),
    });
    expect(archives.json()).toHaveLength(1);
    expect(archives.json()[0].transcripts).toHaveLength(4);

    const transcript = await server.inject({
      method: 'GET',
      url: `/api/archives/${sessionId}/transcripts/channel-en`,
      headers: headers(),
    });
    expect(transcript.statusCode).toBe(200);
    expect(transcript.headers['content-type']).toContain('application/x-ndjson');
    expect(transcript.body).toContain('Grace to you and peace from God our Father.');

    const absentAudio = await server.inject({
      method: 'GET',
      url: `/api/archives/${sessionId}/audio/channel-en`,
      headers: headers(),
    });
    expect(absentAudio.statusCode).toBe(404);
  });

  it('does not issue publisher-capable tokens when the relay is absent', async () => {
    const server = await testServer();
    const response = await server.inject({ method: 'GET', url: '/api/public/token' });
    expect(response.statusCode).toBe(404);
  });
});
