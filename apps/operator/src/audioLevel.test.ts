import { describe, expect, it } from 'vitest';
import { dbToMeterPercent, rmsToDb, signalStatus, smoothDb } from './audioLevel';

describe('audio level display', () => {
  it('uses a real dBFS scale', () => {
    expect(rmsToDb(1)).toBe(0);
    expect(rmsToDb(0.1)).toBeCloseTo(-20);
    expect(rmsToDb(0.001)).toBe(-60);
    expect(dbToMeterPercent(-60)).toBe(0);
    expect(dbToMeterPercent(-30)).toBe(50);
    expect(dbToMeterPercent(0)).toBe(100);
  });

  it('does not label the noise floor as good signal', () => {
    expect(signalStatus(-59)).toBe('Waiting for signal');
    expect(signalStatus(-45)).toBe('Low signal');
    expect(signalStatus(-24)).toBe('Good signal');
    expect(signalStatus(-6)).toBe('Hot');
  });

  it('attacks faster than it releases', () => {
    expect(smoothDb(-60, -20)).toBeGreaterThan(-40);
    expect(smoothDb(-20, -60)).toBeGreaterThan(-30);
  });
});
