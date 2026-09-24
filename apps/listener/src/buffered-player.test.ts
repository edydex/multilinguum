import { describe, expect, it, vi } from 'vitest';
import type { BufferedAudioClip } from '@multilinguum/protocol';
import { BufferedPlayer, type PreparedAudio } from './buffered-player';

const clip = (id = 'one', sequence = 1): BufferedAudioClip => ({
  id,
  sessionId: 'session',
  channelId: 'en',
  language: 'en',
  generation: 0,
  sequence,
  sourceStartAtUnixMs: 10_000,
  sourceEndAtUnixMs: 12_000,
  publishedAtUnixMs: 15_000,
  durationMs: 1000,
  byteLength: 32044,
});
function fixture(video = true) {
  let now = 9000;
  const stopSound = vi.fn();
  let ended = () => {};
  const play = vi.fn((_delay: number, done: () => void) => {
    ended = done;
    return stopSound;
  });
  const load = vi.fn(
    async (_clip: BufferedAudioClip, _signal: AbortSignal): Promise<PreparedAudio> => ({
      durationMs: 1000,
      play,
    }),
  );
  const late = vi.fn(),
    failed = vi.fn(),
    changed = vi.fn();
  const player = new BufferedPlayer(
    { load, late, failed, changed, clock: () => ({ sourceNow: now, serverNow: now + 5000 }) },
    video,
  );
  player.start();
  return {
    player,
    load,
    play,
    late,
    failed,
    stopSound,
    setNow: (value: number) => {
      now = value;
    },
    end: () => ended(),
  };
}
describe('source-timed listener playback', () => {
  it('prefetches once and waits for the matching video time without repeating a clip', async () => {
    const f = fixture();
    await f.player.tick([clip()]);
    await f.player.tick([clip()]);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.play).not.toHaveBeenCalled();
    f.setNow(10_000);
    await f.player.tick([clip()]);
    expect(f.play).toHaveBeenCalledExactlyOnceWith(0, expect.any(Function));
    f.end();
    await f.player.tick([clip()]);
    expect(f.play).toHaveBeenCalledTimes(1);
  });
  it('cancels a pending decode and cannot revive it after stop or a different selection', async () => {
    const f = fixture();
    let finish!: (audio: PreparedAudio) => void;
    f.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.player.tick([clip()]);
    f.player.stop();
    f.player.start();
    finish({ durationMs: 1000, play: f.play });
    await pending;
    f.setNow(10_000);
    await f.player.tick([]);
    expect(f.play).not.toHaveBeenCalled();
    expect(f.load.mock.calls[0]?.[1]?.aborted).toBe(true);
  });
  it('does not overlap phrases and skips an expired prefetched phrase after a stall', async () => {
    const f = fixture();
    f.setNow(10_000);
    await f.player.tick([clip(), clip('two', 2)]);
    await f.player.tick([clip(), clip('two', 2)]);
    await f.player.tick([clip(), clip('two', 2)]);
    expect(f.play).toHaveBeenCalledTimes(1);
    f.setNow(14_000);
    f.end();
    await f.player.tick([clip(), clip('two', 2)]);
    expect(f.play).toHaveBeenCalledTimes(1);
    expect(f.late).toHaveBeenCalledTimes(1);
  });
  it('stops a scheduled or playing source and rejects damaged duration metadata', async () => {
    const f = fixture();
    f.setNow(10_000);
    await f.player.tick([clip()]);
    await f.player.tick([clip()]);
    f.player.stop();
    expect(f.stopSound).toHaveBeenCalledTimes(1);
    f.player.start();
    f.load.mockResolvedValueOnce({ durationMs: 4000, play: f.play });
    await f.player.tick([clip('bad')]);
    expect(f.failed).toHaveBeenCalledWith('Audio timing is unavailable.');
  });
  it('in-person playback uses arrival time and never replays old history on joining', async () => {
    const f = fixture(false);
    f.setNow(20_000);
    await f.player.tick([
      { ...clip(), publishedAtUnixMs: 12_000 },
      { ...clip('new', 2), publishedAtUnixMs: 25_000 },
    ]);
    await f.player.tick([{ ...clip('new', 2), publishedAtUnixMs: 25_000 }]);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.play).toHaveBeenCalledTimes(1);
  });
});

it('schedules consecutive realtime packets without waiting for the prior onended', async () => {
  const f = fixture(false);
  f.setNow(10000);
  const packets = [clip('a', 1), clip('b', 2)].map((value) => ({
    ...value,
    timingBasis: 'output' as const,
  }));
  await f.player.tick(packets);
  await f.player.tick(packets);
  await f.player.tick(packets);
  expect(f.play.mock.calls.map(([delay]) => delay)).toEqual([50, 1050]);
  f.player.stop();
  expect(f.stopSound).toHaveBeenCalled();
});

it('never matches realtime output-clock audio to a source video timestamp', async () => {
  const f = fixture(true);
  await f.player.tick([{ ...clip(), timingBasis: 'output' }]);
  expect(f.load).not.toHaveBeenCalled();
});
