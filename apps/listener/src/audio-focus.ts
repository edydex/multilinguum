import type { Language } from '@multilinguum/protocol';

export type AudioChoice = 'original' | 'muted' | Language;
export interface AudioFocusPorts {
  stopTranslation(): void;
  muteOriginal(): Promise<boolean>;
  unmuteOriginal(): void;
  startTranslation(language: Language): Promise<void>;
  changed(choice: AudioChoice): void;
  failed(message: string): void;
}

/** Every change first stops the old audio, and stale async choices cannot restart it. */
export class AudioFocus {
  private generation = 0;
  constructor(private readonly ports: AudioFocusPorts) {}

  async choose(choice: AudioChoice): Promise<void> {
    const attempt = ++this.generation;
    this.ports.stopTranslation();
    this.ports.changed('muted');
    if (choice === 'original') {
      this.ports.unmuteOriginal();
      this.ports.changed(choice);
      return;
    }
    let muted = false;
    try {
      muted = await this.ports.muteOriginal();
    } catch {
      /* Fail closed on player errors. */
    }
    if (attempt !== this.generation) return;
    if (!muted) {
      this.ports.failed('Could not mute the video. Try again once the YouTube player is ready.');
      return;
    }
    if (choice === 'muted') return;
    this.ports.changed(choice);
    await this.ports.startTranslation(choice);
  }

  /** Also used when the native YouTube controls unmute or seek the video. */
  cancel(): void {
    this.generation += 1;
    this.ports.stopTranslation();
  }
}
