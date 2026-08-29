import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServiceSession } from '@multilinguum/protocol';
import { FileArchiveStore } from './archive-store.js';

function session(id: string): ServiceSession {
  return {
    id,
    state: 'live',
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
    ],
    processingNode: {
      id: 'test',
      name: 'Test',
      mode: 'embedded',
      endpoint: 'http://127.0.0.1:4310',
      identityFingerprint: 'test-identity-fingerprint',
    },
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    relayRoom: `service-${id}`,
    contextDocumentIds: [],
    archivePolicy: {
      retentionDays: 30,
      retainIndefinitely: false,
      recordSource: true,
      recordTranslations: true,
    },
    configurationLocked: true,
    budgetWarningUsd: 20,
    estimatedCostUsd: 0,
  };
}

describe('FileArchiveStore', () => {
  it('writes repeated channel ids only to the explicitly selected session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'multilinguum-archive-'));
    const store = new FileArchiveStore(root, 30);
    await store.create(session('older-session'), { processor: 'test' });
    await store.create(session('current-session'), { processor: 'test' });

    await store.appendAudio('current-session', 'channel-ru', {
      data: new Uint8Array(960),
      encoding: 'pcm_s16le',
      sampleRate: 48_000,
      startMs: 0,
      endMs: 10,
      sequence: 0,
      language: 'ru',
      renderer: 'test',
    });

    await expect(
      access(path.join(root, 'current-session', 'audio', 'channel-ru.pcm')),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(root, 'older-session', 'audio', 'channel-ru.pcm')),
    ).rejects.toThrow();
  });
});
