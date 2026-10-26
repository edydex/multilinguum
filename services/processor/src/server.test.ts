import { once } from 'node:events';
import { issueControlLease } from './control-access.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { DeterministicSpeechRenderer } from './providers/deterministic.js';
import { LiveKitMediaRelay } from './providers/livekit-relay.js';
import {
  OpenAINaturalSpeechRenderer,
  OpenAITextTranslationProvider,
} from './providers/openai-cascade.js';
import type { PublicAudioEvent } from '@multilinguum/protocol';
import { buildServer } from './server.js';
import { MuseLiveTranscriber } from './providers/muse-live-transcriber.js';

const controlToken = 'test-control-token-with-at-least-32-characters';
const servers: FastifyInstance[] = [];

it('limits provider-token changes to the master credential and never returns the secret', async () => {
  const server = await testServer();
  const lease = issueControlLease('fixture', controlToken);
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const response = await server.inject({
      method,
      url: '/api/settings/muse',
      headers: { authorization: `Bearer ${lease.token}` },
      ...(method === 'PUT' ? { payload: { apiKey: 'PRIVATE_MUSE_KEY_SENTINEL' } } : {}),
    });
    expect(response.statusCode).toBe(401);
  }
  vi.spyOn(MuseLiveTranscriber.prototype, 'start').mockResolvedValue(undefined);
  vi.spyOn(MuseLiveTranscriber.prototype, 'stop').mockResolvedValue(undefined);
  const saved = await server.inject({
    method: 'PUT',
    url: '/api/settings/muse',
    headers: headers(),
    payload: { apiKey: 'PRIVATE_MUSE_KEY_SENTINEL' },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ configured: true, source: 'saved' });
  for (const url of ['/api/settings/muse', '/api/preflight', '/api/public/service']) {
    const response = await server.inject({ method: 'GET', url, headers: headers() });
    expect(response.body).not.toContain('PRIVATE_MUSE_KEY_SENTINEL');
  }
  const preflight = (
    await server.inject({ method: 'GET', url: '/api/preflight', headers: headers() })
  ).json();
  expect(preflight.transcription.english.provider).toBe('muse');
  expect(preflight.transcription.russian.provider).toBe('openai');
  await server.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: headers(),
    payload: sessionRequest(),
  });
  const locked = await server.inject({
    method: 'DELETE',
    url: '/api/settings/muse',
    headers: headers(),
  });
  expect(locked.statusCode).toBe(409);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  it('advertises profile readiness without secrets and rejects unavailable selection before creating a session', async () => {
    const server = await testServer({ OPENAI_API_KEY: 'test-audio-key' });
    const preflight = await server.inject({ url: '/api/preflight', headers: headers() });
    expect(preflight.body).not.toContain('test-audio-key');
    expect(preflight.json().translationProfiles).toMatchObject([
      { id: 'quality', ready: true, textModel: 'gpt-6-astra', allowanceVerified: false },
      { id: 'economy', ready: false },
    ]);
    const response = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: { ...sessionRequest(), translationProfile: 'economy' },
    });
    expect(response.statusCode).toBe(409);
    expect(
      (await server.inject({ url: '/api/sessions/current', headers: headers() })).json().session,
    ).toBeUndefined();
  });

  it('requires an explicit Economy note choice and rejects attempts to bypass its text-only provider route', async () => {
    const server = await testServer({
      OPENAI_API_KEY: 'test-audio-key',
      OPENAI_ECONOMY_TEXT_API_KEY: 'test-sharing-key',
      OPENAI_ECONOMY_SHARING_CONFIRMED: 'true',
      OPENAI_ECONOMY_OVERAGE_POLICY: 'allow-billed',
    });
    const body = {
      ...sessionRequest(),
      translationProfile: 'economy',
      targets: sessionRequest()
        .targets.slice(0, 2)
        .map((target) => ({
          ...target,
          translationProvider: target.voiceMode === 'source' ? 'deterministic' : 'openai-cascade',
          speechEnabled: false,
        })),
    };
    const notes = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: { ...body, contextDocumentIds: ['10000000-0000-4000-8000-000000000001'] },
    });
    expect(notes.statusCode).toBe(409);
    expect(notes.json().error).toContain('Share selected notes with Economy');
    const bypass = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: {
        ...body,
        targets: body.targets.map((target) => ({
          ...target,
          translationProvider: 'openai-realtime',
        })),
      },
    });
    expect(bypass.statusCode).toBe(409);
    expect(bypass.json().error).toContain('optional separate speech');
    const uploaded = await server.inject({
      method: 'POST',
      url: '/api/context-documents',
      headers: {
        ...headers(),
        'content-type': 'text/plain',
        'x-sermon-notes-filename': 'Lesson.txt',
      },
      payload: 'Ephesians 4:3: preserve the unity of the Spirit.',
    });
    expect(uploaded.statusCode).toBe(201);
    const accepted = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: {
        ...body,
        contextDocumentIds: [uploaded.json().id],
        shareSermonNotesWithEconomy: true,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      contextDocumentIds: [uploaded.json().id],
      shareSermonNotesWithEconomy: true,
    });
    const publicState = await server.inject({ url: '/api/public/service' });
    expect(publicState.body).not.toContain(uploaded.json().id);
    expect(publicState.body).not.toContain('Lesson.txt');
  });

  it.each([false, true])(
    'runs Economy with explicitly selected notes=%s and no speech requests',
    async (shareNotes) => {
      const requests: Array<{
        url: string;
        authorization: string | null;
        body: Record<string, unknown>;
      }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          requests.push({
            url: String(url),
            authorization: new Headers(init.headers).get('authorization'),
            body: JSON.parse(init.body as string),
          });
          return Response.json({
            id: 'resp_fixture',
            object: 'response',
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg_fixture',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    annotations: [],
                    text: JSON.stringify({
                      translation: 'Grace and peace.',
                      narrationPlan: {
                        role: 'neutral',
                        cadence: 'flowing',
                        arc: 'standalone',
                        pauseBefore: 'none',
                        pauseAfter: 'full',
                        emphasis: [],
                        beats: [],
                      },
                    }),
                  },
                ],
              },
            ],
          });
        }),
      );
      const server = await testServer({
        OPENAI_API_KEY: 'test-audio-key',
        OPENAI_ECONOMY_TEXT_API_KEY: 'test-sharing-key',
        OPENAI_ECONOMY_SHARING_CONFIRMED: 'true',
        OPENAI_ECONOMY_OVERAGE_POLICY: 'allow-billed',
      });
      const note = await server.inject({
        method: 'POST',
        url: '/api/context-documents',
        headers: {
          ...headers(),
          'content-type': 'text/plain',
          'x-sermon-notes-filename': 'Context.txt',
        },
        payload: 'Благодать и мир: grace and peace. Reference name: Ephesus.',
      });
      expect(note.statusCode).toBe(201);
      const response = await server.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: headers(),
        payload: {
          ...sessionRequest(),
          translationProfile: 'economy',
          contextDocumentIds: shareNotes ? [note.json().id] : [],
          shareSermonNotesWithEconomy: shareNotes,
          targets: sessionRequest()
            .targets.slice(0, 2)
            .map((target) => ({
              ...target,
              translationProvider:
                target.voiceMode === 'source' ? 'deterministic' : 'openai-cascade',
              speechEnabled: false,
            })),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        translationProfile: { id: 'economy' },
        costEstimateKind: 'observed-partial',
        estimatedCostUsd: 0,
        usage: { translationRequests: 0, speechRequests: 0, capturedAudioSeconds: 0 },
      });
      expect(requests).toHaveLength(0);
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
      expect(requests).toHaveLength(0);
      const replay = await server.inject({
        method: 'POST',
        url: '/api/sessions/current/replay',
        headers: headers(),
        payload: {
          segments: [
            {
              text: 'Благодать и мир.',
              sourceStartMs: 0,
              sourceEndMs: 2000,
              final: true,
              sequence: 0,
            },
          ],
        },
      });
      expect(replay.statusCode).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: 'https://api.openai.com/v1/responses',
        authorization: 'Bearer test-sharing-key',
        body: { model: 'gpt-5.6-terra' },
      });
      expect(String(requests[0]!.body.input).includes('Reference name: Ephesus.')).toBe(shareNotes);
      expect(String(requests[0]!.body.instructions)).toContain(
        'never add material the speaker did not say',
      );
      const publicResponse = await server.inject({ url: '/api/public/service' });
      expect(publicResponse.body).not.toContain('translationProfile');
      expect(publicResponse.body).not.toContain('test-sharing-key');
      expect(publicResponse.body).not.toContain('knownSubtotalUsd');
      expect(publicResponse.body).not.toContain('inputTokens');
      expect(
        publicResponse
          .json()
          .languages.every((language: { audioAvailable: boolean }) => !language.audioAvailable),
      ).toBe(true);
      const stopped = await server.inject({
        method: 'POST',
        url: '/api/sessions/current/stop',
        headers: headers(),
        payload: {},
      });
      expect(stopped.json().archive).toMatchObject({
        usage: {
          translationRequests: 1,
          speechRequests: 0,
          requestsWithoutPrice: 1,
          incomplete: true,
        },
        sermonNotes: {
          documentIds: shareNotes ? [note.json().id] : [],
          sharedWithEconomy: shareNotes,
        },
        translationProfile: { id: 'economy', textModel: 'gpt-5.6-terra' },
        engineVersions: { translation: 'delayed-original,openai-responses:gpt-5.6-terra' },
      });
    },
  );

  it('cancels a prepared service without starting providers or creating an archive', async () => {
    const server = await testServer();
    await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: sessionRequest(),
    });
    const stopped = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/stop',
      headers: headers(),
      payload: {},
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ session: { state: 'completed' }, archive: null });
    expect((await server.inject({ url: '/api/archives', headers: headers() })).json()).toEqual([]);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/maintenance',
          headers: headers(),
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
  });
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

  it('allows a separate recording-review lease to read finalized archives but never control or delete', async () => {
    vi.spyOn(DeterministicSpeechRenderer.prototype, 'render').mockImplementation(
      async (segment) => ({
        data: new Uint8Array(96000),
        encoding: 'pcm_s16le',
        sampleRate: 48000,
        startMs: segment.sourceStartMs,
        endMs: segment.sourceEndMs,
        sequence: segment.sequence,
        language: segment.language,
        renderer: 'synthetic-silence',
      }),
    );
    const server = await testServer();
    const prepared = sessionRequest();
    await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: prepared,
    });
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/start',
      headers: headers(),
      payload: {},
    });
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/replay',
      headers: headers(),
      payload: {
        segments: [
          {
            text: 'Private recorded sermon.',
            sourceStartMs: 0,
            sourceEndMs: 1000,
            final: true,
            sequence: 0,
          },
        ],
      },
    });
    const stopped = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/stop',
      headers: headers(),
      payload: {},
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    const id = stopped.json().archive.sessionId;
    const minted = await server.inject({
      method: 'POST',
      url: '/api/control/leases',
      headers: headers(),
      payload: { subject: 'reader', scope: 'archive-read' },
    });
    expect(minted.statusCode).toBe(200);
    const reviewHeaders = { ...headers(), authorization: `Bearer ${minted.json().token}` };
    const readPaths = [
      '/api/archives',
      `/api/archives/${id}/transcripts/channel-en`,
      `/api/archives/${id}/audio/channel-en`,
      `/api/archives/${id}/latency`,
    ];
    for (const url of readPaths) {
      const response = await server.inject({ url, headers: reviewHeaders });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['cache-control']).toContain('private, no-store');
      for (const token of [
        '',
        issueControlLease('reader', controlToken).token,
        issueControlLease('reader', controlToken, Date.now() - 600001, 'archive-read').token,
        issueControlLease('reader', controlToken + 'other', Date.now(), 'archive-read').token,
      ]) {
        expect(
          (await server.inject({ url, headers: { authorization: `Bearer ${token}` } })).statusCode,
          url,
        ).toBe(401);
      }
    }
    for (const url of [
      '/api/preflight',
      '/api/sessions/current',
      '/api/context-documents',
      '/api/voice-profiles',
    ]) {
      expect((await server.inject({ url, headers: reviewHeaders })).statusCode, url).toBe(401);
    }
    for (const url of [
      '/api/sessions',
      '/api/sessions/current/start',
      '/api/sessions/current/stop',
      '/api/sessions/current/channels/channel-en',
      '/api/context-documents',
      '/api/control/leases',
      `/api/archives/${id}/retain`,
    ]) {
      expect(
        (await server.inject({ method: 'POST', url, headers: reviewHeaders, payload: {} }))
          .statusCode,
        url,
      ).toBe(401);
    }
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: `/api/archives/${id}`,
          headers: { authorization: reviewHeaders.authorization },
        })
      ).statusCode,
    ).toBe(401);
    const next = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: prepared,
    });
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/start',
      headers: headers(),
      payload: {},
    });
    for (const url of ['/api/operator/events', `/api/capture/audio?sessionId=${next.json().id}`]) {
      const socket = await server.injectWS(url, {
        headers: { 'sec-websocket-protocol': `multilinguum-auth.${minted.json().token}` },
      });
      try {
        expect((await once(socket, 'close'))[0]).toBe(1008);
      } finally {
        socket.terminate();
      }
    }
    expect(
      (await server.inject({ url: '/api/sessions/current', headers: headers() })).json().session
        .state,
    ).toBe('live');
    expect(
      (await server.inject({ url: '/api/archives', headers: headers() }))
        .json()
        .some((item: { sessionId: string }) => item.sessionId === id),
    ).toBe(true);
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/stop',
      headers: headers(),
      payload: {},
    });
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
    for (const url of ['/api/archives', '/api/voice-profiles']) {
      expect((await server.inject({ url, headers: scoped })).statusCode).toBe(401);
    }
    for (const url of ['/api/control/leases', '/api/sessions/current/replay']) {
      expect(
        (await server.inject({ method: 'POST', url, headers: scoped, payload: {} })).statusCode,
      ).toBe(401);
    }
    const notes = await server.inject({
      method: 'POST',
      url: '/api/context-documents',
      headers: {
        ...scoped,
        'content-type': 'text/plain',
        'x-sermon-notes-filename': 'Scoped lesson.txt',
      },
      payload: 'A selected lesson note for translation.',
    });
    expect(notes.statusCode).toBe(201);
    expect(
      (await server.inject({ url: '/api/context-documents', headers: scoped })).json(),
    ).toEqual([notes.json()]);
    expect((await server.inject('/api/context-documents')).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/context-documents',
          headers: {
            'content-type': 'text/plain',
            'x-sermon-notes-filename': 'Unauthenticated.txt',
          },
          payload: 'No access',
        })
      ).statusCode,
    ).toBe(401);
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

  it.each(['quality', 'economy'] as const)(
    'keeps %s speech usable when the configured optional relay is unavailable',
    async (translationProfile) => {
      const relayPublication = vi
        .spyOn(LiveKitMediaRelay.prototype, 'publishChannel')
        .mockRejectedValue(new Error('Synthetic relay outage'));
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          throw new Error('Unexpected external request');
        }),
      );
      vi.spyOn(OpenAITextTranslationProvider.prototype, 'translate').mockImplementation(
        async (segment, context) => ({
          ...segment,
          id: segment.id + '-translated',
          channelId: context.targetLanguage,
          language: context.targetLanguage,
          text: 'Grace to you and peace from God our Father.',
        }),
      );
      const render = vi
        .spyOn(OpenAINaturalSpeechRenderer.prototype, 'render')
        .mockImplementation(async (segment) => ({
          data: new Uint8Array(9600).fill(7),
          encoding: 'pcm_s16le',
          sampleRate: 48000,
          startMs: segment.sourceStartMs,
          endMs: segment.sourceEndMs,
          sequence: segment.sequence,
          language: segment.language,
          renderer: 'synthetic-test',
        }));
      const server = await testServer({
        OPENAI_API_KEY: 'synthetic-audio-key',
        OPENAI_ECONOMY_TEXT_API_KEY: 'synthetic-sharing-key',
        OPENAI_ECONOMY_SHARING_CONFIRMED: 'true',
        OPENAI_ECONOMY_OVERAGE_POLICY: 'allow-billed',
        LIVEKIT_URL: 'wss://relay.invalid',
        LIVEKIT_API_KEY: 'synthetic-relay-key',
        LIVEKIT_API_SECRET: 'synthetic-relay-secret-at-least-32-characters',
      });
      await server.ready();
      const events: PublicAudioEvent[] = [];
      const socket = await server.injectWS('/api/public/events');
      socket.on('message', (data) => events.push(JSON.parse(data.toString())));
      try {
        const request = sessionRequest();
        const created = await server.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: headers(),
          payload: {
            ...request,
            translationProfile,
            archivePolicy: {
              ...request.archivePolicy,
              recordSource: false,
              recordTranslations: false,
            },
            targets: request.targets
              .slice(0, 2)
              .map((channel) => ({ ...channel, translationProvider: 'openai-cascade' })),
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
        const replay = (sequence: number) =>
          server.inject({
            method: 'POST',
            url: '/api/sessions/current/replay',
            headers: headers(),
            payload: {
              segments: [
                {
                  text: 'Благодать вам и мир от Бога Отца нашего.',
                  sourceStartMs: 0,
                  sourceEndMs: 1000,
                  sequence,
                  final: true,
                },
              ],
            },
          });
        expect((await replay(0)).statusCode).toBe(200);
        await new Promise((resolve) => setImmediate(resolve));
        const clip = events.find((event) => event.type === 'audio-clip');
        expect(clip?.type).toBe('audio-clip');
        if (clip?.type !== 'audio-clip') throw new Error('Missing buffered audio');
        const audioUrl = `/api/public/audio/${clip.clip.sessionId}/${clip.clip.id}.wav`;
        const audio = await server.inject(audioUrl);
        expect(audio.statusCode).toBe(200);
        expect(audio.rawPayload.indexOf(Buffer.alloc(9600, 7))).toBeGreaterThanOrEqual(44);
        expect((await server.inject('/api/public/token?language=en')).statusCode).toBe(409);
        const speech = (speechEnabled: boolean) =>
          server.inject({
            method: 'POST',
            url: '/api/sessions/current/channels/channel-en',
            headers: headers(),
            payload: { speechEnabled },
          });
        expect((await speech(false)).statusCode).toBe(200);
        expect((await server.inject(audioUrl)).statusCode).toBe(410);
        expect((await replay(1)).json().translated).toHaveLength(2);
        expect(render).toHaveBeenCalledTimes(1);
        expect((await speech(true)).statusCode).toBe(200);
        expect((await server.inject(audioUrl)).statusCode).toBe(410);
        expect((await replay(2)).statusCode).toBe(200);
        expect(render).toHaveBeenCalledTimes(2);
        const stopped = await server.inject({
          method: 'POST',
          url: '/api/sessions/current/stop',
          headers: headers(),
          payload: {},
        });
        expect(stopped.statusCode, stopped.body).toBe(200);
        expect(relayPublication).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        socket.terminate();
      }
    },
  );

  it('keeps the configured relay required for direct Realtime audio', async () => {
    const publish = vi
      .spyOn(LiveKitMediaRelay.prototype, 'publishChannel')
      .mockRejectedValue(new Error('Synthetic direct-audio relay outage'));
    const server = await testServer({
      LIVEKIT_URL: 'wss://relay.invalid',
      LIVEKIT_API_KEY: 'synthetic-relay-key',
      LIVEKIT_API_SECRET: 'synthetic-relay-secret-at-least-32-characters',
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
          .map((channel) => ({ ...channel, translationProvider: 'openai-realtime' })),
      },
    });
    expect(created.statusCode).toBe(200);
    const started = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/start',
      headers: headers(),
      payload: {},
    });
    expect(started.statusCode).toBe(409);
    expect(started.json().error).toBe('Synthetic direct-audio relay outage');
    expect(publish).toHaveBeenCalledOnce();
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
    expect((await server.inject({ url: '/client/heritage.js' })).headers['cache-control']).toBe(
      'no-store',
    );
    expect(
      (await server.inject({ url: '/client/livekit-client.esm-123.js' })).headers['cache-control'],
    ).toContain('immutable');
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
      expect(events.every((event) => ['public-state', 'audio-clear'].includes(event.type))).toBe(
        true,
      );
      expect(JSON.stringify(events)).not.toContain('identityFingerprint');
      expect(JSON.stringify(events)).not.toContain('processingNode');
    } finally {
      socket.terminate();
    }
  });
});

it('serves only current live PCM and revokes clip URLs when voice turns off or a session ends', async () => {
  vi.spyOn(DeterministicSpeechRenderer.prototype, 'render').mockImplementation(async (segment) => ({
    data: new Uint8Array(9600),
    encoding: 'pcm_s16le',
    sampleRate: 48000,
    startMs: segment.sourceStartMs,
    endMs: segment.sourceEndMs,
    sequence: segment.sequence,
    language: segment.language,
    renderer: 'synthetic-pcm-test',
  }));
  const server = await testServer();
  await server.ready();
  const events: PublicAudioEvent[] = [];
  const socket = await server.injectWS('/api/public/events');
  socket.on('message', (data) => events.push(JSON.parse(data.toString())));
  try {
    const request = sessionRequest();
    request.targets = request.targets.slice(0, 2);
    const created = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: request,
    });
    expect(created.statusCode).toBe(200);
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/start',
      headers: headers(),
      payload: {},
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/replay',
      headers: headers(),
      payload: {
        segments: [
          {
            text: 'Благодать вам и мир от Бога Отца нашего.',
            language: 'ru',
            sourceStartMs: 0,
            sourceEndMs: 1000,
            sequence: 1,
            final: true,
          },
        ],
      },
    });
    expect(replay.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    const event = events.find((event) => event.type === 'audio-clip');
    expect(event?.type).toBe('audio-clip');
    if (event?.type !== 'audio-clip') throw new Error('No audio metadata');
    const url = `/api/public/audio/${event.clip.sessionId}/${event.clip.id}.wav`;
    const audio = await server.inject({ url, headers: { origin: 'https://heritage.faith' } });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(audio.headers['cache-control']).toBe('no-store');
    expect(audio.headers['access-control-allow-origin']).toBe('*');
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect(audio.rawPayload.byteLength).toBe(event.clip.byteLength);
    expect(
      (await server.inject({ url: '/api/public/audio/not-a-session/private.env.wav' })).statusCode,
    ).toBe(404);
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/channels/channel-en',
      headers: headers(),
      payload: { speechEnabled: false },
    });
    expect((await server.inject({ url })).statusCode).toBe(410);
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/channels/channel-en',
      headers: headers(),
      payload: { speechEnabled: true },
    });
    expect((await server.inject({ url })).statusCode).toBe(410);
    await server.inject({
      method: 'POST',
      url: '/api/sessions/current/stop',
      headers: headers(),
      payload: {},
    });
    expect((await server.inject({ url })).statusCode).toBe(410);
  } finally {
    socket.terminate();
  }
});

it('cue commands cannot start or stop a replaced session', async () => {
  const server = await testServer();
  const created = await server.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: headers(),
    payload: sessionRequest(),
  });
  const id = created.json().id;
  const other = '00000000-0000-4000-8000-000000000000';
  for (const action of ['start', 'stop']) {
    const rejected = await server.inject({
      method: 'POST',
      url: `/api/sessions/current/${action}`,
      headers: headers(),
      payload: { expectedSessionId: other },
    });
    expect(rejected.statusCode).toBe(409);
  }
  expect(
    (await server.inject({ url: '/api/sessions/current', headers: headers() })).json().session
      .state,
  ).toBe('preflight');
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/sessions/current/start',
        headers: headers(),
        payload: { expectedSessionId: id },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/sessions/current/stop',
        headers: headers(),
        payload: { expectedSessionId: id },
      })
    ).statusCode,
  ).toBe(200);
});

it('prewarms provider connections but discards incoming audio until the exact session is live', async () => {
  const { RealtimeCapturePipeline } = await import('./realtime-capture-pipeline.js');
  let finishWarmup!: () => void;
  vi.spyOn(RealtimeCapturePipeline.prototype, 'start').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishWarmup = resolve;
      }),
  );
  vi.spyOn(RealtimeCapturePipeline.prototype, 'close').mockResolvedValue(undefined);
  const push = vi.spyOn(RealtimeCapturePipeline.prototype, 'push').mockImplementation(() => {});
  const server = await testServer({ OPENAI_API_KEY: 'test-key-never-sent-to-provider' });
  const created = await server.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: headers(),
    payload: sessionRequest(),
  });
  expect(created.statusCode).toBe(200);
  const id = created.json().id;
  const socket = await server.injectWS(`/api/capture/audio?sessionId=${id}`, {
    headers: { 'sec-websocket-protocol': `multilinguum-auth.${controlToken}` },
  });
  try {
    expect(finishWarmup).toBeTypeOf('function');
    const message = once(socket, 'message');
    finishWarmup();
    const ready = JSON.parse(String((await message)[0]));
    expect(ready).toEqual({ type: 'capture-ready', sessionId: id });
    const packet = Buffer.alloc(20);
    packet.writeDoubleLE(Date.now(), 4);
    packet.writeUInt32LE(2, 12);
    socket.send(packet);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(push).not.toHaveBeenCalled();
    const started = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/start',
      headers: headers(),
      payload: { expectedSessionId: id },
    });
    expect(started.statusCode).toBe(200);
    socket.send(packet);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(push).toHaveBeenCalledTimes(1);
    const stopped = await server.inject({
      method: 'POST',
      url: '/api/sessions/current/stop',
      headers: headers(),
      payload: { expectedSessionId: id },
    });
    expect(stopped.statusCode).toBe(200);
  } finally {
    socket.terminate();
    vi.restoreAllMocks();
  }
});
