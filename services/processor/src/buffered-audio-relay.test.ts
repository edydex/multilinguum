import { describe, expect, it, vi } from 'vitest';
import type {
  BufferedAudioClip,
  ChannelConfig,
  MediaRelay,
  RenderedSpeech,
  ServiceSession,
} from '@multilinguum/protocol';
import { BufferedAudioRelay } from './buffered-audio-relay.js';

const start = Date.parse('2026-09-13T12:00:00Z');
const channel = {
  id: 'ru',
  targetLanguage: 'ru',
  translationProvider: 'openai-cascade',
  voiceMode: 'natural',
  speechEnabled: true,
} as ChannelConfig;
const session = { id: 'service-a', startedAt: new Date(start).toISOString() } as ServiceSession;
function speech(sequence = 1): RenderedSpeech {
  return {
    data: new Uint8Array(32_000).fill(7),
    encoding: 'pcm_s16le',
    sampleRate: 16_000,
    startMs: 2_000,
    endMs: 4_000,
    sequence,
    language: 'ru',
    renderer: 'test-pcm',
  };
}
async function fixture(options: ConstructorParameters<typeof BufferedAudioRelay>[3] = {}) {
  const delegate: MediaRelay = {
    name: 'test',
    onListenerCount: () => () => undefined,
    createSession: async () => undefined,
    publishChannel: async (config) => ({
      channelId: config.id,
      roomName: 'test',
      trackName: 'test',
    }),
    audioBacklogMs: () => 0,
    clearAudio: vi.fn(),
    publishAudio: vi.fn(async () => undefined),
    publishCaption: vi.fn(async () => undefined),
    closeSession: async () => undefined,
  };
  const published: BufferedAudioClip[] = [];
  const clear = vi.fn();
  const relay = new BufferedAudioRelay(delegate, (clip) => published.push(clip), clear, {
    now: () => start + 5_000,
    ...options,
  });
  await relay.createSession(session);
  await relay.publishChannel(channel);
  return { relay, delegate, published, clear };
}

describe('bounded source-timed audio window', () => {
  it('packages the existing speech once and separates source time from rendered duration', async () => {
    const { relay, delegate, published } = await fixture();
    const chunk = speech();
    await relay.publishAudio(channel.id, chunk);
    expect(delegate.publishAudio).toHaveBeenCalledExactlyOnceWith(channel.id, chunk);
    expect(published[0]).toMatchObject({
      sourceStartAtUnixMs: start + 2_000,
      sourceEndAtUnixMs: start + 4_000,
      durationMs: 1_000,
      generation: 0,
    });
    const stored = relay.read(session.id, published[0]!.id)!;
    expect(stored.wave.subarray(0, 4).toString()).toBe('RIFF');
    expect(stored.wave.readUInt32LE(24)).toBe(16_000);
    expect(stored.wave.readUInt32LE(40)).toBe(32_000);
    expect(stored.wave.subarray(44)).toEqual(Buffer.from(chunk.data));
    chunk.data.fill(0);
    expect(stored.wave[44]).toBe(7);
    expect(relay.read('other-service', published[0]!.id)).toBeUndefined();
  });

  it('bounds retained bytes and lifetime without retaining expired clip URLs', async () => {
    let now = start;
    const { relay, published } = await fixture({
      maximumBytes: 65_000,
      retentionMs: 1_000,
      now: () => now,
    });
    await relay.publishAudio(channel.id, speech(1));
    await relay.publishAudio(channel.id, speech(2));
    await relay.publishAudio(channel.id, speech(3));
    expect(relay.snapshot(session.id).map((clip) => clip.sequence)).toEqual([2, 3]);
    expect(relay.read(session.id, published[0]!.id)).toBeUndefined();
    now += 1_001;
    expect(relay.snapshot(session.id)).toEqual([]);
    expect(relay.read(session.id, published[2]!.id)).toBeUndefined();
  });

  it('clears queued browser speech immediately, including during relay publication', async () => {
    const { relay, delegate, published, clear } = await fixture();
    let finish!: () => void;
    vi.mocked(delegate.publishAudio).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = relay.publishAudio(channel.id, speech());
    expect(published).toHaveLength(1);
    relay.clearAudio(channel.id);
    expect(clear).toHaveBeenCalledWith(session.id, channel.id, 1);
    expect(relay.read(session.id, published[0]!.id)).toBeUndefined();
    finish();
    await pending;
    expect(relay.snapshot(session.id)).toEqual([]);
    await relay.publishAudio(channel.id, speech(2));
    expect(published[1]!.generation).toBe(1);
  });

  it('drops old session clips and never treats an output-clock stream as source-aligned audio', async () => {
    const { relay, published } = await fixture();
    await relay.publishAudio(channel.id, speech());
    await relay.closeSession(session.id);
    expect(relay.read(session.id, published[0]!.id)).toBeUndefined();
    await relay.createSession({ ...session, id: 'service-b' });
    await relay.publishChannel({ ...channel, translationProvider: 'openai-realtime' });
    await relay.publishAudio(channel.id, speech());
    expect(relay.snapshot('service-b')).toEqual([]);
    expect(published).toHaveLength(1);
  });

  it('does not expose empty, malformed or oversized audio as a playable clip', async () => {
    const { relay, published } = await fixture({ maximumBytes: 65_000 });
    for (const chunk of [
      { ...speech(), data: new Uint8Array() },
      { ...speech(), data: new Uint8Array(3) },
      { ...speech(), sampleRate: 0 },
      { ...speech(), data: new Uint8Array(66_000) },
      { ...speech(), startMs: Number.NaN },
    ])
      await relay.publishAudio(channel.id, chunk);
    expect(published).toEqual([]);
  });
});

it('uses capture-clock timing instead of assuming the microphone began with the session', async () => {
  const { relay, published } = await fixture();
  await relay.publishAudio(channel.id, {
    ...speech(),
    sourceStartAtUnixMs: start + 32000,
    sourceEndAtUnixMs: start + 34000,
  });
  expect(published[0]).toMatchObject({
    sourceStartAtUnixMs: start + 32000,
    sourceEndAtUnixMs: start + 34000,
  });
});
