import type { BufferedAudioClip } from '@multilinguum/protocol';

export interface PreparedAudio {
  durationMs: number;
  play(delayMs: number, ended: () => void): () => void;
}
export interface BufferedPlayerPorts {
  load(clip: BufferedAudioClip, signal: AbortSignal): Promise<PreparedAudio>;
  clock(): { sourceNow: number; serverNow: number };
  changed(playing: boolean): void;
  late(): void;
  failed(message: string): void;
}

/** One playing phrase and one prefetched phrase; no audio overlaps or unbounded catch-up. */
export class BufferedPlayer {
  private attempt = 0;
  private enabled = false;
  private loading = false;
  private abort = new AbortController();
  private ready: { clip: BufferedAudioClip; audio: PreparedAudio } | undefined;
  private stopPlaying: (() => void) | undefined;
  private consumed = new Set<string>();
  private highestSequence = -1;
  private selectedAt = 0;
  private outputNextAt = 0;
  private outputStops = new Set<() => void>();
  constructor(
    private readonly ports: BufferedPlayerPorts,
    private readonly video: boolean,
  ) {}

  start(): void {
    this.stop();
    this.enabled = true;
    this.selectedAt = this.ports.clock().serverNow;
  }
  stop(): void {
    this.enabled = false;
    this.attempt++;
    this.abort.abort();
    this.abort = new AbortController();
    this.loading = false;
    this.ready = undefined;
    for (const stop of this.outputStops) stop();
    this.outputStops.clear();
    this.outputNextAt = 0;
    this.stopPlaying?.();
    this.stopPlaying = undefined;
    this.consumed.clear();
    this.highestSequence = -1;
    this.ports.changed(false);
  }
  async tick(clips: BufferedAudioClip[]): Promise<void> {
    if (!this.enabled) return;
    const attempt = this.attempt;
    const current = () => this.enabled && this.attempt === attempt;
    clips = clips.filter((clip) => !this.video || clip.timingBasis !== 'output');
    const deadline = (clip: BufferedAudioClip) =>
      this.video ? clip.sourceStartAtUnixMs : clip.publishedAtUnixMs;
    const clock = () => (this.video ? this.ports.clock().sourceNow : this.ports.clock().serverNow);
    const maximumLate = this.video ? 3000 : 15000;
    if (!Number.isFinite(clock())) return;
    // The Set is bounded by the server's window even through a long service.
    const retained = new Set(clips.map((clip) => clip.id));
    for (const id of this.consumed) if (!retained.has(id)) this.consumed.delete(id);
    if (this.ready?.clip.timingBasis === 'output' && this.outputNextAt <= clock() + 2000) {
      const { clip, audio } = this.ready;
      this.ready = undefined;
      this.highestSequence = Math.max(this.highestSequence, clip.sequence);
      // Schedule decoded chunks on the audio clock before the previous chunk ends.
      // Waiting for onended adds a tick-sized silence at every packet boundary.
      const startAt = Math.max(clock() + 50, this.outputNextAt);
      this.outputNextAt = startAt + audio.durationMs;
      try {
        const stop = audio.play(startAt - clock(), () => {
          if (!current()) return;
          this.outputStops.delete(stop);
          if (!this.outputStops.size) this.ports.changed(false);
        });
        this.outputStops.add(stop);
        this.ports.changed(true);
      } catch {
        this.stop();
        this.ports.failed('Audio playback stopped. Choose audio again.');
        return;
      }
    }
    if (this.ready && this.ready.clip.timingBasis !== 'output' && !this.stopPlaying) {
      const { clip, audio } = this.ready;
      const waitMs = deadline(clip) - clock();
      if (waitMs < -maximumLate) {
        this.ready = undefined;
        this.ports.late();
      } else if (waitMs <= 150) {
        this.ready = undefined;
        this.highestSequence = Math.max(this.highestSequence, clip.sequence);
        try {
          this.stopPlaying = audio.play(Math.max(0, waitMs), () => {
            if (!current()) return;
            this.stopPlaying = undefined;
            this.ports.changed(false);
          });
          this.ports.changed(true);
        } catch {
          this.stop();
          this.ports.failed('Audio playback stopped. Choose audio again.');
          return;
        }
      }
    }
    if (this.loading || this.ready) return;
    const next = [...clips]
      .sort((a, b) => deadline(a) - deadline(b) || a.sequence - b.sequence)
      .find((clip) => {
        if (this.consumed.has(clip.id) || clip.sequence < this.highestSequence) return false;
        if (
          (!this.video && clip.publishedAtUnixMs < this.selectedAt - 1500) ||
          deadline(clip) < clock() - maximumLate
        ) {
          this.consumed.add(clip.id);
          return false;
        }
        return deadline(clip) <= clock() + 30_000;
      });
    if (!next) return;
    this.loading = true;
    this.consumed.add(next.id);
    try {
      const audio = await this.ports.load(next, this.abort.signal);
      if (!current()) return;
      if (Math.abs(audio.durationMs - next.durationMs) > 100)
        throw new Error('Audio timing is unavailable.');
      this.ready = { clip: next, audio };
    } catch (cause) {
      if (!current()) return;
      this.stop();
      this.ports.failed(cause instanceof Error ? cause.message : 'Audio could not be loaded.');
    } finally {
      if (current()) this.loading = false;
    }
  }
}
