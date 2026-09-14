import { expect, it } from 'vitest';
import type { BufferedAudioClip, PublicServiceState } from '@multilinguum/protocol';
import {
  appendAudioClip,
  clearAudioWindow,
  emptyAudioWindow,
  updateAudioWindow,
} from './audio-window';
const sessionId = '10000000-0000-4000-8000-000000000001';
const clip: BufferedAudioClip = {
  id: '20000000-0000-4000-8000-000000000001',
  sessionId,
  channelId: 'en',
  language: 'en',
  generation: 0,
  sequence: 1,
  sourceStartAtUnixMs: 10000,
  sourceEndAtUnixMs: 11000,
  publishedAtUnixMs: 12000,
  durationMs: 1000,
  byteLength: 32044,
};
const service: PublicServiceState = {
  active: true,
  sessionId,
  serverTimeUnixMs: 12000,
  churchName: 'Test',
  languages: [
    {
      language: 'en',
      voiceMode: 'natural',
      available: true,
      bufferedAudioAvailable: true,
      channelId: 'en',
      audioGeneration: 0,
      disclosure: 'Test',
    },
  ],
};
it('fences stale audio by service and channel generation, including delayed heartbeat updates', () => {
  let w = updateAudioWindow(emptyAudioWindow(), service);
  w = appendAudioClip(w, clip);
  expect(w.clips).toHaveLength(1);
  w = clearAudioWindow(w, sessionId, 'en', 1);
  expect(w.clips).toEqual([]);
  w = updateAudioWindow(w, service);
  expect(w.generations.en).toBe(1);
  expect(appendAudioClip(w, clip).clips).toEqual([]);
  w = appendAudioClip(w, { ...clip, generation: 1 });
  expect(w.clips).toHaveLength(1);
  w = updateAudioWindow(w, { ...service, active: false });
  expect(w.clips).toEqual([]);
  expect(appendAudioClip(w, clip).clips).toEqual([]);
});
it('deduplicates and rejects malformed audio URLs, lengths and timestamps', () => {
  const w = appendAudioClip(updateAudioWindow(emptyAudioWindow(), service), clip);
  expect(appendAudioClip(w, clip).clips).toHaveLength(1);
  for (const invalid of [
    { ...clip, id: '../private' },
    { ...clip, durationMs: Infinity },
    { ...clip, byteLength: 32_000_000 },
    { ...clip, sessionId: 'other' },
  ])
    expect(appendAudioClip(w, invalid)).toBe(w);
});
