import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { AccessToken } from 'livekit-server-sdk';
import { z, ZodError } from 'zod';
import type { ProcessorEvent, PublicServiceState } from '@multilinguum/protocol';
import { transcriptInputSchema } from '@multilinguum/protocol';
import type { WebSocket } from 'ws';
import { FileArchiveStore } from './archive-store.js';
import type { ProcessorConfig } from './config.js';
import { BroadcastMediaRelay } from './providers/broadcast-relay.js';
import {
  DeterministicSpeechRenderer,
  DeterministicTranslationProvider,
} from './providers/deterministic.js';
import {
  OpenAINaturalSpeechRenderer,
  OpenAITextTranslationProvider,
} from './providers/openai-cascade.js';
import { VoiceWorkerSpeechRenderer } from './providers/voice-worker.js';
import { LiveKitMediaRelay } from './providers/livekit-relay.js';
import { SessionEngine } from './session-engine.js';
import { VoiceProfileStore } from './voice-profile-store.js';
import { OpenAILiveTranscriber } from './providers/openai-live-transcriber.js';
import { OpenAIRealtimeTranslationChannel } from './providers/openai-realtime-translation.js';
import { RealtimeCapturePipeline } from './realtime-capture-pipeline.js';

const replaySchema = z.object({
  segments: z.array(transcriptInputSchema).min(1).max(10_000),
});

const channelActionSchema = z.object({
  muted: z.boolean().optional(),
  forceNatural: z.boolean().optional(),
  restart: z.boolean().optional(),
});

function hasControlToken(request: FastifyRequest, expected: string): boolean {
  const authorization = request.headers.authorization;
  const actual = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicState(config: ProcessorConfig, engine: SessionEngine): PublicServiceState {
  const session = engine.current();
  const active = session?.state === 'live';
  return {
    active,
    churchName: config.CHURCH_NAME,
    ...(active && session
      ? {
          sessionId: session.id,
          ...(session.startedAt ? { startedAt: session.startedAt } : {}),
          languages: session.targets.map((channel) => ({
            language: channel.targetLanguage,
            voiceMode: channel.voiceMode,
            available: !channel.muted,
            disclosure:
              channel.voiceMode === 'source'
                ? 'Original delayed audio'
                : 'AI-generated translated voice',
          })),
        }
      : { languages: [] }),
  };
}

export async function buildServer(config: ProcessorConfig) {
  const app = Fastify({ logger: config.NODE_ENV !== 'test' });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  await app.register(cors, {
    origin: config.NODE_ENV === 'production' ? config.PROCESSOR_PUBLIC_URL : true,
  });
  await app.register(websocket);

  const operatorSockets = new Set<WebSocket>();
  const publicSockets = new Set<WebSocket>();
  const lastCaptions = new Map<string, ProcessorEvent>();
  const broadcast = (event: ProcessorEvent) => {
    const payload = JSON.stringify(event);
    if (event.type === 'transcript') lastCaptions.set(event.segment.channelId, event);
    for (const socket of operatorSockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
    if (event.type === 'transcript' || event.type === 'session' || event.type === 'health') {
      for (const socket of publicSockets) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
  };

  const archive = new FileArchiveStore(config.ARCHIVE_ROOT, config.ARCHIVE_RETENTION_DAYS);
  const profiles = new VoiceProfileStore(config.ARCHIVE_ROOT);
  const deterministicTranslation = new DeterministicTranslationProvider();
  const deterministicSpeech = new DeterministicSpeechRenderer();
  const cloudTranslation = config.OPENAI_API_KEY
    ? new OpenAITextTranslationProvider(config.OPENAI_API_KEY, config.OPENAI_TEXT_MODEL)
    : undefined;
  const naturalSpeech = config.OPENAI_API_KEY
    ? new OpenAINaturalSpeechRenderer(config.OPENAI_API_KEY, config.OPENAI_TTS_MODEL)
    : undefined;
  const clonedSpeech = config.VOICE_WORKER_URL
    ? new VoiceWorkerSpeechRenderer(config.VOICE_WORKER_URL.toString(), config.VOICE_WORKER_TOKEN)
    : undefined;
  const realtimeTranscriberFactory = config.OPENAI_API_KEY
    ? () => new OpenAILiveTranscriber(config.OPENAI_API_KEY!, config.OPENAI_TRANSCRIBE_MODEL)
    : undefined;
  const realtimeTranslationFactory = config.OPENAI_API_KEY
    ? () =>
        new OpenAIRealtimeTranslationChannel(config.OPENAI_API_KEY!, config.OPENAI_TRANSLATE_MODEL)
    : undefined;
  const relay =
    config.LIVEKIT_URL && config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET
      ? new LiveKitMediaRelay(
          config.LIVEKIT_URL.toString(),
          config.LIVEKIT_API_KEY,
          config.LIVEKIT_API_SECRET,
          broadcast,
        )
      : new BroadcastMediaRelay(broadcast);
  const engine = new SessionEngine({
    archive,
    relay,
    profiles,
    deterministicTranslation,
    deterministicSpeech,
    broadcast,
    ...(cloudTranslation ? { cloudTranslation } : {}),
    ...(naturalSpeech ? { naturalSpeech } : {}),
    ...(clonedSpeech ? { clonedSpeech } : {}),
    ...(config.OPENAI_API_KEY
      ? {
          realtimeTranslationEngine: `openai-realtime-translate:${config.OPENAI_TRANSLATE_MODEL}`,
          liveTranscriptionEngine: `openai-live-transcribe:${config.OPENAI_TRANSCRIBE_MODEL}`,
        }
      : {}),
  });

  const requireControl = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasControlToken(request, config.PROCESSOR_CONTROL_TOKEN)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: error.issues });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 409;
    return reply.code(status).send({ error: message });
  });

  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));

  app.get('/api/preflight', { preHandler: requireControl }, async () => {
    const disk = await statfs(config.ARCHIVE_ROOT);
    const voice = clonedSpeech
      ? await clonedSpeech.health()
      : { ready: false, detail: 'Not configured' };
    return {
      readyForDeterministicReplay: true,
      openai: {
        configured: Boolean(config.OPENAI_API_KEY),
        realtimeTranslationModel: config.OPENAI_TRANSLATE_MODEL,
        transcriptionModel: config.OPENAI_TRANSCRIBE_MODEL,
        liveAccessVerified: false,
      },
      livekit: {
        configured: Boolean(
          config.LIVEKIT_URL && config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET,
        ),
        liveAccessVerified: false,
      },
      voiceWorker: voice,
      archive: {
        root: config.ARCHIVE_ROOT,
        freeBytes: disk.bavail * disk.bsize,
        retentionDays: config.ARCHIVE_RETENTION_DAYS,
      },
    };
  });

  app.get('/api/public/service', async () => publicState(config, engine));

  app.get('/api/public/token', async (_request, reply) => {
    const session = engine.current();
    if (session?.state !== 'live' || !session.relayRoom) {
      return reply.code(404).send({ error: 'No live service.' });
    }
    if (!config.LIVEKIT_URL || !config.LIVEKIT_API_KEY || !config.LIVEKIT_API_SECRET) {
      return reply.code(503).send({ error: 'Media relay is not configured.' });
    }
    const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
      identity: `listener-${randomUUID()}`,
      ttl: '5m',
      metadata: JSON.stringify({ role: 'anonymous-listener' }),
    });
    token.addGrant({
      room: session.relayRoom,
      roomJoin: true,
      canPublish: false,
      canPublishData: false,
      canSubscribe: true,
    });
    return {
      url: config.LIVEKIT_URL.toString(),
      token: await token.toJwt(),
      expiresInSeconds: 300,
    };
  });

  app.get('/api/public/events', { websocket: true }, (socket) => {
    publicSockets.add(socket);
    socket.send(JSON.stringify({ type: 'public-state', state: publicState(config, engine) }));
    for (const event of lastCaptions.values()) socket.send(JSON.stringify(event));
    socket.on('close', () => publicSockets.delete(socket));
  });

  app.get('/api/operator/events', { websocket: true }, (socket, request) => {
    const token = (request.query as { token?: string }).token ?? '';
    const left = Buffer.from(token);
    const right = Buffer.from(config.PROCESSOR_CONTROL_TOKEN);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      socket.close(1008, 'Unauthorized');
      return;
    }
    operatorSockets.add(socket);
    const session = engine.current();
    if (session) socket.send(JSON.stringify({ type: 'session', session } satisfies ProcessorEvent));
    for (const health of engine.health()) {
      socket.send(JSON.stringify({ type: 'health', health } satisfies ProcessorEvent));
    }
    socket.on('close', () => operatorSockets.delete(socket));
  });

  let captureActive = false;
  app.get('/api/capture/audio', { websocket: true }, (socket, request) => {
    const query = request.query as { token?: string; sessionId?: string };
    const supplied = Buffer.from(query.token ?? '');
    const expected = Buffer.from(config.PROCESSOR_CONTROL_TOKEN);
    const session = engine.current();
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      !session ||
      session.id !== query.sessionId ||
      session.state !== 'live'
    ) {
      socket.close(1008, 'Unauthorized or inactive session');
      return;
    }
    const forwardedProtocol = request.headers['x-forwarded-proto'];
    const secure = request.protocol === 'https' || forwardedProtocol === 'https';
    const loopback = request.hostname === '127.0.0.1' || request.hostname === 'localhost';
    if (config.NODE_ENV === 'production' && !secure && !loopback) {
      socket.close(1008, 'Remote capture requires TLS');
      return;
    }
    if (!realtimeTranscriberFactory || !realtimeTranslationFactory) {
      socket.close(1013, 'OpenAI Realtime processing is not configured');
      return;
    }
    if (captureActive) {
      socket.close(1013, 'Another capture console is already streaming');
      return;
    }
    captureActive = true;
    const pipeline = new RealtimeCapturePipeline(
      engine,
      session,
      realtimeTranscriberFactory(),
      realtimeTranslationFactory,
    );
    const ready = pipeline.start();
    socket.on('message', (message, isBinary) => {
      try {
        if (!isBinary) throw new Error('Capture frames must be binary.');
        const packet = Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer);
        if (packet.byteLength < 16) throw new Error('Capture frame header is incomplete.');
        const capturedAt = packet.readDoubleLE(4);
        const sampleCount = packet.readUInt32LE(12);
        if (!Number.isFinite(capturedAt) || Math.abs(Date.now() - capturedAt) > 60_000) {
          throw new Error('Capture timestamp is outside the accepted clock window.');
        }
        if (packet.byteLength !== 16 + sampleCount * 2 || sampleCount > 48_000) {
          throw new Error('Capture frame length is invalid.');
        }
        const frame = new Uint8Array(packet.buffer, packet.byteOffset + 16, sampleCount * 2);
        void ready
          .then(() => pipeline.push(frame, capturedAt))
          .catch((error) =>
            socket.close(
              1013,
              error instanceof Error ? error.message : 'Realtime pipeline failed to start',
            ),
          );
      } catch (error) {
        socket.close(1003, error instanceof Error ? error.message : 'Invalid capture frame');
      }
    });
    socket.on('close', () => {
      captureActive = false;
      void ready.then(() => pipeline.close()).catch((error) => app.log.error(error));
    });
  });

  app.post('/api/sessions', { preHandler: requireControl }, async (request) =>
    engine.create(request.body),
  );
  app.get('/api/sessions/current', { preHandler: requireControl }, async () => ({
    session: engine.current(),
    health: engine.health(),
  }));
  app.post('/api/sessions/current/start', { preHandler: requireControl }, async () =>
    engine.start(),
  );
  app.post('/api/sessions/current/stop', { preHandler: requireControl }, async () => engine.stop());
  app.post('/api/sessions/current/replay', { preHandler: requireControl }, async (request) => {
    const replay = replaySchema.parse(request.body);
    const translated = [];
    for (const segment of replay.segments) {
      translated.push(...(await engine.ingestTranscript(segment)));
    }
    return { translated };
  });
  app.post(
    '/api/sessions/current/channels/:channelId',
    { preHandler: requireControl },
    async (request) => {
      const { channelId } = request.params as { channelId: string };
      const action = channelActionSchema.parse(request.body);
      if (action.muted !== undefined) await engine.setMuted(channelId, action.muted);
      if (action.forceNatural) await engine.forceNatural(channelId);
      if (action.restart) await engine.restartChannel(channelId);
      return engine.health().find((health) => health.channelId === channelId);
    },
  );

  app.get('/api/archives', { preHandler: requireControl }, async () => archive.list());
  app.get(
    '/api/archives/:sessionId/audio/:channelId',
    { preHandler: requireControl },
    async (request, reply) => {
      const { sessionId, channelId } = request.params as {
        sessionId: string;
        channelId: string;
      };
      const track = await archive.readAudioTrack(sessionId, channelId);
      return reply
        .header('content-type', 'audio/ogg; codecs=opus')
        .header('content-disposition', `inline; filename="${track.filename}"`)
        .send(track.data);
    },
  );
  app.get(
    '/api/archives/:sessionId/transcripts/:channelId',
    { preHandler: requireControl },
    async (request, reply) => {
      const { sessionId, channelId } = request.params as {
        sessionId: string;
        channelId: string;
      };
      const transcript = await archive.readTranscript(sessionId, channelId);
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', `attachment; filename="${transcript.filename}"`)
        .send(transcript.data);
    },
  );
  app.get(
    '/api/archives/:sessionId/latency',
    { preHandler: requireControl },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const report = await archive.readLatency(sessionId);
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', `attachment; filename="${report.filename}"`)
        .send(report.data);
    },
  );
  app.post('/api/archives/:sessionId/retain', { preHandler: requireControl }, async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const { retained } = z.object({ retained: z.boolean() }).parse(request.body);
    return archive.retain(sessionId, retained);
  });
  app.delete('/api/archives/:sessionId', { preHandler: requireControl }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    await archive.delete(sessionId);
    return reply.code(204).send();
  });

  app.get('/api/voice-profiles', { preHandler: requireControl }, async () => profiles.list());
  app.post('/api/voice-profiles', { preHandler: requireControl }, async (request, reply) =>
    reply.code(201).send(await profiles.create(request.body)),
  );
  app.put(
    '/api/voice-profiles/:profileId/sample',
    { preHandler: requireControl },
    async (request, reply) => {
      if (!clonedSpeech) {
        return reply.code(503).send({ error: 'The cloned-voice worker is not configured.' });
      }
      const { profileId } = request.params as { profileId: string };
      const profile = await profiles.get(profileId);
      if (!profile) return reply.code(404).send({ error: 'Voice profile not found.' });
      const sample = request.body;
      if (!Buffer.isBuffer(sample) || sample.byteLength === 0) {
        return reply.code(400).send({ error: 'A non-empty reference audio file is required.' });
      }
      await clonedSpeech.installProfile(profile, sample);
      return profiles.markReady(profile.id);
    },
  );
  app.post(
    '/api/voice-profiles/:profileId/ready',
    { preHandler: requireControl },
    async (request) => {
      const { profileId } = request.params as { profileId: string };
      return profiles.markReady(profileId);
    },
  );
  app.post(
    '/api/voice-profiles/:profileId/revoke',
    { preHandler: requireControl },
    async (request) => {
      const { profileId } = request.params as { profileId: string };
      if (clonedSpeech) await clonedSpeech.revokeProfile(profileId);
      return profiles.revoke(profileId);
    },
  );

  app.post('/api/pairing/offer', { preHandler: requireControl }, async () => {
    const code = String(Number.parseInt(randomBytes(4).toString('hex'), 16) % 1_000_000).padStart(
      6,
      '0',
    );
    return {
      code,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      endpoint: config.PROCESSOR_PUBLIC_URL,
      note: 'The production remote-node milestone replaces this bootstrap response with mTLS pairing.',
    };
  });

  const retentionTimer = setInterval(() => {
    void archive.purgeExpired().catch((error) => app.log.error(error));
  }, 60 * 60_000);
  retentionTimer.unref();
  app.addHook('onClose', async () => clearInterval(retentionTimer));

  return app;
}
