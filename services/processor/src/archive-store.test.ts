import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServiceSession } from '@multilinguum/protocol';
import { ServiceUsageMeter } from '@multilinguum/protocol';
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
  it('includes the private usage receipt in the persisted archive integrity hash', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'multilinguum-usage-'));
    const store = new FileArchiveStore(root, 30);
    try {
      const value = session('usage');
      value.archivePolicy.recordSource = false;
      value.archivePolicy.recordTranslations = false;
      await store.create(value, { processor: 'test' });
      const meter = new ServiceUsageMeter('gpt-transcribe');
      meter.recordAudio(0, 96_000);
      const finalized = await store.finalize(value.id, meter.snapshot());
      const file = path.join(root, value.id, 'manifest.json');
      const persisted = JSON.parse(await readFile(file, 'utf8'));
      expect(persisted.usage).toEqual(meter.snapshot());
      expect(persisted).toEqual(finalized);
      const { integritySha256, ...payload } = persisted;
      expect(createHash('sha256').update(JSON.stringify(payload)).digest('hex')).toBe(
        integritySha256,
      );
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'enforces source=%s / translation=%s recording at the archive boundary',
    async (recordSource, recordTranslations) => {
      const root = await mkdtemp(path.join(tmpdir(), 'multilinguum-record-policy-'));
      const store = new FileArchiveStore(root, 30);
      const configured = session('recording-policy');
      configured.archivePolicy = { ...configured.archivePolicy, recordSource, recordTranslations };
      configured.targets.push({
        id: 'channel-en',
        targetLanguage: 'en',
        translationProvider: 'openai-cascade',
        voiceMode: 'natural',
        fallbackOrder: ['mute'],
        muted: false,
      });
      try {
        const manifest = await store.create(configured, { processor: 'test' });
        expect(manifest.audioTracks.map((track) => track.channelId)).toEqual([
          ...(recordSource ? ['channel-ru'] : []),
          ...(recordTranslations ? ['channel-en'] : []),
        ]);
        for (const [channelId, enabled] of [
          ['channel-ru', recordSource],
          ['channel-en', recordTranslations],
        ] as const) {
          if (enabled) continue;
          await expect(
            store.appendAudio(configured.id, channelId, {
              data: new Uint8Array(960),
              encoding: 'pcm_s16le',
              sampleRate: 48000,
              startMs: 0,
              endMs: 10,
              sequence: 0,
              language: 'ru',
              renderer: 'test',
            }),
          ).rejects.toThrow();
          await expect(
            access(path.join(root, configured.id, 'audio', `${channelId}.pcm`)),
          ).rejects.toThrow();
        }
        expect(manifest.transcripts).toHaveLength(2);
      } finally {
        store.close();
      }
    },
  );

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
