export interface VideoSample {
  time: number;
  playing: boolean;
}

/** YouTube's media clock has no capture timestamp. Anchor once using the measured delay. */
export class VideoTimeline {
  private anchor: { media: number; server: number } | undefined;
  private latest: VideoSample | undefined;
  private interrupted = false;
  reset(): void {
    this.anchor = undefined;
    this.latest = undefined;
    this.interrupted = false;
  }
  interrupt(): void {
    if (this.anchor) this.interrupted = true;
    if (this.latest) this.latest = { ...this.latest, playing: false };
  }
  sample(sample: VideoSample, serverNow: number, delayMs: number): number | undefined {
    if (!Number.isFinite(sample.time) || sample.time < 0) return;
    this.latest = sample;
    if (!this.anchor && !this.interrupted && sample.playing) this.align(serverNow);
    if (!this.anchor || this.interrupted) return;
    return this.anchor.server + (sample.time - this.anchor.media) * 1000 - delayMs;
  }
  align(serverNow: number): boolean {
    if (!this.latest?.playing) return false;
    this.anchor = { media: this.latest.time, server: serverNow };
    this.interrupted = false;
    return true;
  }
  get needsAlignment(): boolean {
    return this.interrupted;
  }
}
