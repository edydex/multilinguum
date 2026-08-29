import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment, VoiceProfile } from '@multilinguum/protocol';
import { VoiceWorkerSpeechRenderer } from './voice-worker.js';

const profileId = '3b75a4bf-b3df-4a0f-97a8-87a8a842b4af';

function profile(referenceLanguage?: 'en' | 'ru'): VoiceProfile {
  return {
    id: profileId,
    displayName: 'Michael',
    ...(referenceLanguage ? { referenceLanguage } : {}),
    encryptedSampleLocation: `voice-worker://profiles/${profileId}`,
    sampleSha256: 'a'.repeat(64),
    supportedLanguages: ['en'],
    consent: {
      id: '718f5211-a75a-4c04-bdcf-bb9a34d899df',
      speakerName: 'Michael Example',
      confirmedAt: '2026-08-29T12:00:00.000Z',
      authorizerName: 'Operator Example',
      permittedUse: 'Church-service interpretation',
      permittedLanguages: ['en'],
      evidenceReference: 'Recorded confirmation',
    },
    status: 'ready',
    createdAt: '2026-08-29T12:00:00.000Z',
  };
}

function segment(): TranscriptSegment {
  return {
    id: 'segment-1',
    sessionId: 'session-1',
    channelId: 'channel-en',
    language: 'en',
    text: 'Grace and peace to you.',
    sourceStartMs: 0,
    sourceEndMs: 1_500,
    emittedAt: '2026-08-29T12:00:00.000Z',
    final: true,
    sequence: 0,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('voice worker renderer', () => {
  it('uses zero CFG for cross-language or legacy profiles to reduce accent transfer', async () => {
    const cfgWeights: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { cfgWeight: number };
        cfgWeights.push(body.cfgWeight);
        return new Response(new Uint8Array([1, 0, 2, 0]));
      }),
    );
    const renderer = new VoiceWorkerSpeechRenderer(
      'http://voice-worker.example.test:4320',
      'test-worker-token',
    );

    await renderer.render(segment(), profile('ru'));
    await renderer.render(segment(), profile());
    await renderer.render(segment(), profile('en'));

    expect(cfgWeights).toEqual([0, 0, 0.35]);
  });

  it('installs a pending sample through the encrypted worker boundary', async () => {
    const pending = { ...profile('en'), status: 'pending' as const };
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response(JSON.stringify({ status: 'installed' }), { status: 200 });
      }),
    );
    const renderer = new VoiceWorkerSpeechRenderer(
      'http://voice-worker.example.test:4320',
      'test-worker-token',
    );

    await renderer.installProfile(pending, Uint8Array.from([82, 73, 70, 70]));

    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.body).toBeInstanceOf(FormData);
    expect((requests[0]?.headers as Record<string, string>)['x-consent-active']).toBe('true');
  });
});
