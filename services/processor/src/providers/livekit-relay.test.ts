import { beforeEach, expect, it, vi } from 'vitest';
import type { ChannelConfig, ServiceSession } from '@multilinguum/protocol';

const media = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  capture: vi.fn(async () => undefined),
  clear: vi.fn(),
}));
vi.mock('@livekit/rtc-node', () => ({
  AudioFrame: class {},
  AudioSource: class {
    queuedDuration = 0;
    captureFrame = media.capture;
    clearQueue = media.clear;
    waitForPlayout = async () => undefined;
  },
  LocalAudioTrack: { createAudioTrack: () => ({ close: async () => undefined }) },
  Room: class {
    connect = media.connect;
    disconnect = async () => undefined;
    on = () => undefined;
    remoteParticipants = new Map();
    localParticipant = { publishTrack: async () => undefined, publishData: async () => undefined };
  },
  RoomEvent: {},
  TrackPublishOptions: class {},
  TrackSource: {},
}));
import { LiveKitMediaRelay } from './livekit-relay.js';

const channel: ChannelConfig = {
  id: 'en',
  targetLanguage: 'en',
  translationProvider: 'openai-cascade',
  voiceMode: 'natural',
  muted: false,
  fallbackOrder: ['mute'],
  speechEnabled: true,
};
const session = { id: 'session', relayRoom: 'test', targets: [channel] } as ServiceSession;
beforeEach(() => vi.clearAllMocks());

it('does not contact the audio relay for text-only channels', async () => {
  const relay = new LiveKitMediaRelay('wss://relay.invalid', 'key', 'secret', () => undefined);
  await relay.createSession(session);
  await relay.publishChannel({ ...channel, speechEnabled: false });
  expect(media.connect).not.toHaveBeenCalled();
  await relay.closeSession(session.id);
});

it('stops an in-progress publication after audio is cleared', async () => {
  let release!: () => void;
  media.capture.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const relay = new LiveKitMediaRelay('wss://relay.invalid', 'key', 'secret', () => undefined);
  await relay.createSession(session);
  await relay.publishChannel(channel);
  const publishing = relay.publishAudio(channel.id, {
    data: new Uint8Array(960 * 4),
    encoding: 'pcm_s16le',
    sampleRate: 48000,
    startMs: 0,
    endMs: 40,
    sequence: 0,
    language: 'en',
    renderer: 'test',
  });
  expect(media.capture).toHaveBeenCalledTimes(1);
  relay.clearAudio(channel.id);
  release();
  await publishing;
  expect(media.clear).toHaveBeenCalledTimes(1);
  expect(media.capture).toHaveBeenCalledTimes(1);
  await relay.closeSession(session.id);
});
