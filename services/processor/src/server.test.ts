import { once } from 'node:events';
import { issueControlLease } from './control-access.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

async function testServer(overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'multilinguum-processor-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    PROCESSOR_CONTROL_TOKEN: controlToken,
    PROCESSOR_PUBLIC_URL: 'http://127.0.0.1:4310',
    ARCHIVE_ROOT: root,
    ...overrides,
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
  it('quiesces idle translation for backups and refuses maintenance during a service', async () => {
    const server = await testServer();
    const maintenance = (enabled: boolean) =>
      server.inject({
        method: 'POST',
        url: '/api/maintenance',
        headers: headers(),
        payload: { enabled },
      });
    expect((await maintenance(true)).json()).toEqual({ maintenance: true });
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: headers(),
          payload: sessionRequest(),
        })
      ).statusCode,
    ).toBe(503);
    const scoped = issueControlLease('operator', controlToken);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/maintenance',
          headers: { authorization: `Bearer ${scoped.token}` },
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(401);
    expect((await maintenance(false)).statusCode).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: headers(),
          payload: sessionRequest(),
        })
      ).statusCode,
    ).toBe(200);
    expect((await maintenance(true)).statusCode).toBe(409);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/sessions/current/start',
          headers: headers(),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await maintenance(true)).statusCode).toBe(409);
    expect((await server.inject('/health')).json().maintenance).toBe(false);
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/stop',
      headers: headers(),
      payload: {},
    });
    expect((await maintenance(true)).statusCode).toBe(200);
  });

  it('authenticates and renews a scoped operator WebSocket without disconnecting it', async () => {
    const server = await testServer();
    await server.ready();
    const first = issueControlLease('community:1:user:2', controlToken);
    const socket = await server.injectWS('/api/operator/events', {
      headers: { 'sec-websocket-protocol': `multilinguum-auth.${first.token}` },
    });
    try {
      const received = once(socket, 'message');
      const next = issueControlLease('community:1:user:2', controlToken);
      socket.send(JSON.stringify({ type: 'renew-auth', token: next.token }));
      expect(JSON.parse(String((await received)[0]))).toMatchObject({
        type: 'auth-renewed',
        expiresAtUnixMs: next.expiresAtUnixMs,
      });
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ type: 'renew-auth', token: controlToken }));
      expect((await closed)[0]).toBe(1008);
    } finally {
      socket.terminate();
    }
  });

  it('limits Community leases to live control and serializes concurrent service creation', async () => {
    const server = await testServer();
    const minted = await server.inject({
      method: 'POST',
      url: '/api/control/leases',
      headers: headers(),
      payload: { subject: 'community:1:user:2' },
    });
    expect(minted.statusCode).toBe(200);
    expect(minted.headers['cache-control']).toContain('no-store');
    const scoped = {
      authorization: `Bearer ${minted.json().token}`,
      'content-type': 'application/json',
    };
    expect((await server.inject({ url: '/api/preflight', headers: scoped })).statusCode).toBe(200);
    for (const url of ['/api/archives', '/api/context-documents', '/api/voice-profiles']) {
      expect((await server.inject({ url, headers: scoped })).statusCode).toBe(401);
    }
    for (const url of ['/api/control/leases', '/api/sessions/current/replay']) {
      expect(
        (await server.inject({ method: 'POST', url, headers: scoped, payload: {} })).statusCode,
      ).toBe(401);
    }
    const created = await Promise.all(
      [1, 2].map(() =>
        server.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: scoped,
          payload: sessionRequest(),
        }),
      ),
    );
    expect(created.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/sessions/current/start',
          headers: scoped,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const current = await server.inject({ url: '/api/sessions/current', headers: scoped });
    expect(current.json().capture).toEqual({ connected: false, ready: false });
    expect(current.headers['cache-control']).toContain('no-store');
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/sessions/current/stop',
          headers: scoped,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });

  it('runs text with an unreachable configured relay and reports audio controls accurately', async () => {
    const server = await testServer({
      LIVEKIT_URL: 'wss://relay.invalid',
      LIVEKIT_API_KEY: 'test-key',
      LIVEKIT_API_SECRET: 'test-secret-at-least-32-characters',
    });
    const request = sessionRequest();
    const created = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: {
        ...request,
        targets: request.targets
          .slice(0, 2)
          .map((channel) => ({ ...channel, speechEnabled: false })),
      },
    });
    expect(created.statusCode).toBe(200);
    const started = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/start',
      headers: headers(),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    const state = (await server.inject('/api/public/service')).json();
    expect(state.active).toBe(true);
    expect(state.languages).toHaveLength(2);
    expect(
      state.languages.every(
        (channel: { available: boolean; audioAvailable: boolean }) =>
          channel.available && !channel.audioAvailable,
      ),
    ).toBe(true);
    expect((await server.inject('/api/public/token?language=en')).statusCode).toBe(404);
    const anonymous = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/channels/channel-en',
      payload: { speechEnabled: true },
    });
    expect(anonymous.statusCode).toBe(401);
    const replay = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/replay',
      headers: headers(),
      payload: {
        segments: [
          {
            text: 'Благодать вам и мир от Бога Отца нашего.',
            sourceStartMs: 0,
            sourceEndMs: 2000,
            final: true,
            sequence: 0,
          },
        ],
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().translated).toHaveLength(2);
    const stop = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/stop',
      headers: headers(),
      payload: {},
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().archive.audioTracks).toHaveLength(0);
    expect(stop.json().archive.transcripts).toHaveLength(2);
  });

  it('allows cloud-only production configuration without a GPU-worker secret', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', PROCESSOR_CONTROL_TOKEN: controlToken }),
    ).not.toThrow();
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PROCESSOR_CONTROL_TOKEN: controlToken,
        VOICE_WORKER_URL: 'http://voice-worker:4320',
      }),
    ).toThrow('VOICE_WORKER_TOKEN');
  });

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

    const captureCompletedAtUnixMs = Date.now() - 1_000;

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
            timing: {
              captureCompletedAtUnixMs,
              chunkReadyAtUnixMs: captureCompletedAtUnixMs + 25,
              transcriptionEngine: 'test-transcriber',
              transcription: {
                startedAtUnixMs: captureCompletedAtUnixMs + 100,
                completedAtUnixMs: captureCompletedAtUnixMs + 350,
              },
            },
          },
        ],
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().translated).toHaveLength(4);
    expect(
      replay.json().translated.find((item: { language: string }) => item.language === 'en').text,
    ).toBe('Grace to you and peace from God our Father.');

    const current = await server.inject({
      method: 'GET',
      url: '/api/sessions/current',
      headers: headers(),
    });
    const englishHealth = current
      .json()
      .health.find((item: { channelId: string }) => item.channelId === 'channel-en');
    expect(englishHealth.latency.sampleCount).toBe(1);
    expect(englishHealth.latency.p95.transcriptionMs).toBe(250);
    expect(englishHealth.latency.p95.translationMs).toBeGreaterThanOrEqual(0);

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
    expect(stopped.json().archive.latencyReport.sampleCount).toBe(4);
    expect(stopped.json().archive.latencyReport.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stopped.json().archive.latencyReport.channels['channel-en'].p95.transcriptionMs).toBe(
      250,
    );

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

    const latency = await server.inject({
      method: 'GET',
      url: `/api/archives/${sessionId}/latency`,
      headers: headers(),
    });
    expect(latency.statusCode).toBe(200);
    expect(latency.headers['content-type']).toContain('application/x-ndjson');
    expect(latency.body).toContain('sourceEndToTranscriptMs');

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

  it('accepts private sermon notes and locks the selected context into the session', async () => {
    const server = await testServer();
    const uploaded = await server.inject({
      method: 'POST',
      url: '/api/context-documents',
      headers: {
        authorization: `Bearer ${controlToken}`,
        'content-type': 'text/plain',
        'x-sermon-notes-filename': encodeURIComponent('Sunday Notes.txt'),
      },
      payload:
        'Ефесянам 4:3 — сохранять единство Духа. Ephesians 4:3 — preserve the unity of the Spirit.',
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().filename).toBe('Sunday Notes.txt');

    const created = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: { ...sessionRequest(), contextDocumentIds: [uploaded.json().id] },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().contextDocumentIds).toEqual([uploaded.json().id]);
  });
});

describe('public Heritage client contract', () => {
  it('serves only installed JavaScript and keeps operator access private across origins', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'multilinguum-client-'));
    await writeFile(path.join(root, 'heritage.js'), 'export const clientVersion = 1;');
    await writeFile(path.join(root, 'livekit-client.esm-123.js'), 'export {};');
    await writeFile(path.join(root, 'private.env'), 'not public');
    const server = await testServer({ NODE_ENV: 'production', LISTENER_CLIENT_ROOT: root });
    for (const url of [
      '/client/heritage.js',
      '/client/livekit-client.esm-123.js',
      '/api/public/service',
    ]) {
      const response = await server.inject({
        url,
        headers: { origin: 'https://another-church.example' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('*');
    }
    for (const url of [
      '/client/missing.js',
      '/client/private.env',
      '/client/%2e%2e%2fprivate.env',
    ]) {
      expect((await server.inject({ url })).statusCode).toBe(404);
    }
    const operator = await server.inject({
      url: '/api/preflight',
      headers: { origin: 'https://another-church.example' },
    });
    expect(operator.statusCode).toBe(401);
    expect(operator.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('publishes availability updates without private session or health configuration', async () => {
    const server = await testServer();
    await server.ready();
    const socket = await server.injectWS('/api/public/events');
    const events: Array<{
      type: string;
      state?: { active: boolean; languages: Array<{ audioAvailable?: boolean }> };
    }> = [];
    socket.on('message', (data) => {
      events.push(JSON.parse(data.toString()));
    });
    try {
      const request = sessionRequest();
      request.targets = request.targets.slice(0, 2);
      await server.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: headers(),
        payload: {
          ...request,
          targets: request.targets.map((channel) => ({ ...channel, speechEnabled: false })),
        },
      });
      await server.inject({
        method: 'POST',
        url: '/api/sessions/current/start',
        headers: headers(),
        payload: {},
      });
      const muted = await server.inject({
        method: 'POST',
        url: '/api/sessions/current/channels/channel-en',
        headers: headers(),
        payload: { muted: true },
      });
      expect(muted.statusCode).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.some((event) => event.type === 'public-state' && event.state?.active)).toBe(
        true,
      );
      expect(events.every((event) => event.type === 'public-state')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('identityFingerprint');
      expect(JSON.stringify(events)).not.toContain('processingNode');
    } finally {
      socket.terminate();
    }
  });
});
