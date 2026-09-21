import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioChunk, ServiceSession, TranscriptSegment } from '@multilinguum/protocol';
import { MuseLiveTranscriber, type MuseSocket } from './muse-live-transcriber.js';
import { transcriptionKeywords } from './transcription-keywords.js';
import { selectTranscription } from '../transcription-selection.js';
import { loadConfig } from '../config.js';

class Socket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  acknowledge = true;
  drain = true;
  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }
  send(data: string | Uint8Array, callback?: (error?: Error) => void) {
    this.sent.push(data);
    if (typeof data === 'string') {
      const event = JSON.parse(data);
      if (event.authorization && this.acknowledge)
        queueMicrotask(() => this.receive({ sessionId: 'provider-session' }));
      if (event.type === 'endStream' && this.drain) queueMicrotask(() => this.close());
    }
    callback?.();
  }
  receive(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
  close() {
    this.readyState = 3;
    this.emit('close', 1000);
  }
  terminate() {
    this.readyState = 3;
    this.emit('close', 1006);
  }
}
const session = {
  id: 'sermon',
  sourceLanguage: 'en',
  contextDocumentIds: [],
} as unknown as ServiceSession;
function chunk(startMs = 0): AudioChunk {
  return {
    data: new Uint8Array(4_800),
    encoding: 'pcm_s16le',
    sampleRate: 24_000,
    startMs,
    endMs: startMs + 100,
    sequence: 0,
  };
}
function setup(options: ConstructorParameters<typeof MuseLiveTranscriber>[1] = {}) {
  const sockets: Socket[] = [];
  const adapter = new MuseLiveTranscriber('PRIVATE_TOKEN_SENTINEL', {
    pace: false,
    ...options,
    socketFactory: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as MuseSocket;
    },
  });
  const segments: TranscriptSegment[] = [];
  const errors: string[] = [];
  adapter.onSegment((segment) => segments.push(segment));
  adapter.onError((error) => errors.push(error.message));
  return { adapter, sockets, segments, errors };
}
afterEach(() => vi.useRealTimers());

describe('Muse streaming contract', () => {
  it('authenticates in a JSON handshake and sends PCM only after acknowledgement', async () => {
    const { adapter, sockets } = setup({ keywords: async () => ['Nebuchadnezzar', 'Ezekiel'] });
    await adapter.start(session);
    expect(JSON.parse(sockets[0]!.sent[0] as string)).toMatchObject({
      authorization: { accessToken: 'Bearer PRIVATE_TOKEN_SENTINEL' },
      mode: 'ENDPOINTING',
      audioEncoding: 'PCM_24KHZ',
      languageBias: ['English'],
      keywords: ['Nebuchadnezzar', 'Ezekiel'],
    });
    await adapter.pushAudio(chunk());
    adapter.flushAudio();
    expect(sockets[0]!.sent).toHaveLength(2);
    expect(sockets[0]!.sent[1]).toBeInstanceOf(Uint8Array);
    await adapter.stop();
    expect(JSON.parse(sockets[0]!.sent.at(-1) as string)).toEqual({ type: 'endStream' });
  });
  it('replaces cumulative partials and orders overlapping completed turns using their IDs', async () => {
    const { adapter, sockets, segments } = setup();
    await adapter.start(session);
    await adapter.pushAudio(chunk(500));
    const socket = sockets[0]!;
    socket.receive({ type: 'speechStart', turnId: 11, audioProcessedMs: 10 });
    socket.receive({ type: 'transcript', transcript: 'Grace', audioProcessedMs: 20 });
    socket.receive({ type: 'transcript', transcript: 'Grace and peace', audioProcessedMs: 30 });
    socket.receive({ type: 'speechEnd', turnId: 11, audioProcessedMs: 40 });
    socket.receive({ type: 'speechStart', turnId: 12, audioProcessedMs: 45 });
    socket.receive({ type: 'transcript', transcript: 'From God', audioProcessedMs: 55 });
    socket.receive({
      type: 'speechComplete',
      turnId: 12,
      transcript: 'From God.',
      audioProcessedMs: 65,
    });
    expect(segments.filter((s) => s.final)).toEqual([]);
    socket.receive({
      type: 'speechComplete',
      turnId: 11,
      transcript: 'Grace and peace.',
      audioProcessedMs: 70,
    });
    socket.receive({
      type: 'speechComplete',
      turnId: 11,
      transcript: 'DUPLICATE',
      audioProcessedMs: 70,
    });
    expect(segments.filter((s) => !s.final).map((s) => s.text)).toEqual([
      'Grace',
      'Grace and peace',
      'From God',
    ]);
    expect(
      segments
        .filter((s) => s.final)
        .map((s) => [s.sequence, s.text, s.sourceStartMs, s.sourceEndMs]),
    ).toEqual([
      [0, 'Grace and peace.', 510, 540],
      [1, 'From God.', 545, 565],
    ]);
    expect(segments[0]!.id).toEqual(segments[3]!.id);
    await adapter.stop();
  });
  it('rejects unsupported Russian before opening a connection', async () => {
    const { adapter, sockets } = setup();
    await expect(adapter.start({ ...session, sourceLanguage: 'ru' })).rejects.toThrow(
      'does not support Russian',
    );
    expect(sockets).toHaveLength(0);
  });
  it('does not disclose request data or credentials in provider errors', async () => {
    const { adapter, sockets, errors } = setup();
    await adapter.start(session);
    sockets[0]!.receive({ type: 'error', message: 'PRIVATE_TOKEN_SENTINEL sermon-private-notes' });
    await expect(adapter.pushAudio(chunk())).rejects.toThrow('Muse transcription failed');
    await adapter.stop();
    expect(errors.join()).not.toMatch(/PRIVATE_TOKEN|sermon-private-notes/);
  });
  it('drains final turns at stop instead of treating speechEnd as the transcript', async () => {
    const { adapter, sockets, segments } = setup();
    await adapter.start(session);
    const socket = sockets[0]!;
    socket.drain = false;
    socket.receive({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
    socket.receive({ type: 'speechEnd', turnId: 1, audioProcessedMs: 100 });
    const stopped = adapter.stop();
    socket.receive({
      type: 'speechComplete',
      turnId: 1,
      transcript: 'Amen.',
      audioProcessedMs: 100,
    });
    socket.close();
    await stopped;
    expect(segments.map((s) => s.text)).toEqual(['Amen.']);
  });
  it('rotates before the session cap without reusing turn identities or resetting source time', async () => {
    const { adapter, sockets, segments } = setup({ rotateAfterMs: 100 });
    await adapter.start(session);
    await adapter.pushAudio(chunk(400));
    sockets[0]!.receive({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
    sockets[0]!.receive({
      type: 'speechComplete',
      turnId: 1,
      transcript: 'First.',
      audioProcessedMs: 100,
    });
    await adapter.pushAudio(chunk(500));
    expect(sockets).toHaveLength(2);
    sockets[1]!.receive({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
    sockets[1]!.receive({
      type: 'speechComplete',
      turnId: 1,
      transcript: 'Second.',
      audioProcessedMs: 100,
    });
    expect(segments.map((s) => [s.sequence, s.sourceStartMs])).toEqual([
      [0, 400],
      [1, 500],
    ]);
    expect(segments[0]!.id).not.toEqual(segments[1]!.id);
    await adapter.stop();
  });
  it('reports a bounded stop timeout and an incomplete turn', async () => {
    vi.useFakeTimers();
    const { adapter, sockets, errors } = setup({ drainMs: 20 });
    await adapter.start(session);
    sockets[0]!.drain = false;
    sockets[0]!.receive({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
    const stopping = adapter.stop();
    await vi.advanceTimersByTimeAsync(21);
    await stopping;
    expect(errors.join()).toMatch(/stop timeout/);
    expect(errors.join()).toMatch(/without a final transcript/);
  });
  it('bounds keyword hints and prefers explicit Muse only when language and credentials allow it', () => {
    const hints = transcriptionKeywords('en', [
      'Ezekiel spoke about Nebuchadnezzar. Nebuchadnezzar came to Egypt.',
    ]);
    expect(hints).toContain('Nebuchadnezzar');
    expect(hints).toContain('Ezekiel');
    expect(transcriptionKeywords('en', ['Rareword '.repeat(100_000)])).toHaveLength(9);
    const config = loadConfig({ MUSE_API_KEY: 'muse-fixture', OPENAI_API_KEY: 'openai-fixture' });
    expect(selectTranscription(config, 'en').provider).toBe('muse');
    expect(selectTranscription(config, 'ru')).toMatchObject({ provider: 'openai', ready: true });
    expect(selectTranscription(config, 'ru', 'muse').ready).toBe(false);
    expect(selectTranscription(config, 'en', 'openai').provider).toBe('openai');
    expect(selectTranscription(loadConfig({}), 'en', 'muse').ready).toBe(false);
  });
});
