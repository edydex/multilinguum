export type SignalStatus = 'Waiting for signal' | 'Low signal' | 'Good signal' | 'Hot';

export function rmsToDb(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return -60;
  return Math.max(-60, Math.min(0, 20 * Math.log10(rms)));
}

export function smoothDb(previousDb: number, nextDb: number): number {
  const coefficient = nextDb > previousDb ? 0.55 : 0.12;
  return previousDb + (nextDb - previousDb) * coefficient;
}

export function dbToMeterPercent(db: number): number {
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

export function signalStatus(db: number): SignalStatus {
  if (db < -52) return 'Waiting for signal';
  if (db < -38) return 'Low signal';
  if (db < -10) return 'Good signal';
  return 'Hot';
}
