import { expect, it } from 'vitest';
import { VideoTimeline } from './video-timeline';
it('uses the measured capture delay and follows media time rather than wall time drift', () => {
  const t = new VideoTimeline();
  expect(t.sample({ time: 100, playing: false }, 50_000, 10_000)).toBeUndefined();
  expect(t.sample({ time: 100, playing: true }, 50_000, 10_000)).toBe(40_000);
  expect(t.sample({ time: 102, playing: true }, 55_000, 10_000)).toBe(42_000);
  expect(t.sample({ time: 102, playing: true }, 55_000, 15_000)).toBe(37_000);
});
it('requires explicit re-alignment after seeking, pausing or buffering and resets between services', () => {
  const t = new VideoTimeline();
  t.sample({ time: 100, playing: true }, 50_000, 10_000);
  t.interrupt();
  expect(t.needsAlignment).toBe(true);
  expect(t.sample({ time: 150, playing: false }, 60_000, 10_000)).toBeUndefined();
  expect(t.align(60_000)).toBe(false);
  expect(t.sample({ time: 160, playing: true }, 70_000, 10_000)).toBeUndefined();
  expect(t.align(70_000)).toBe(true);
  expect(t.sample({ time: 162, playing: true }, 72_000, 10_000)).toBe(62_000);
  t.reset();
  expect(t.needsAlignment).toBe(false);
  expect(t.sample({ time: 0, playing: false }, 80_000, 10_000)).toBeUndefined();
});
