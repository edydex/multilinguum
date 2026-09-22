export interface SlideTranslationCommand {
  serviceId: string;
  serviceRevision: string;
  segmentId: string;
  phase: 'prepare' | 'live' | 'idle';
}
export interface SlideTranslationStatus {
  phase: 'idle' | 'preparing' | 'ready' | 'starting' | 'live' | 'stopping' | 'error';
  message?: string;
}
export interface SlideAutomationBridge {
  version: 1;
  onCommand(handler: (command: SlideTranslationCommand) => void): () => void;
  report(status: SlideTranslationStatus): void;
  getInput(): Promise<{ id: string; label: string } | null>;
  saveInput(input: { id: string; label: string }): Promise<void>;
}
type Owned = { key: string; sessionId: string; live: boolean };

/** Only this controller's sessions may be stopped. Navigation replaces a desired
 * state; it never queues a series of obsolete Start button presses. */
export class SlideAutomation {
  private desired: SlideTranslationCommand | undefined;
  private owned: Owned | undefined;
  private running = false;
  private generation = 0;
  private failure: string | undefined;
  private mustStop = false;
  constructor(
    private readonly io: {
      prepare(command: SlideTranslationCommand, cancelled: () => boolean): Promise<string>;
      ready(sessionId: string, cancelled: () => boolean): Promise<void>;
      start(sessionId: string): Promise<void>;
      stop(sessionId: string): Promise<void>;
      disconnect(): void;
      report(status: SlideTranslationStatus): void;
    },
  ) {}

  command(command: SlideTranslationCommand) {
    if (
      !command ||
      !['prepare', 'live', 'idle'].includes(command.phase) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(command.serviceId) ||
      !/^[a-f0-9]{64}$/.test(command.serviceRevision) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(command.segmentId)
    )
      return;
    this.failure = undefined;
    this.desired = command;
    this.generation++;
    void this.reconcile();
  }
  fail(message: string) {
    this.failure = message;
    this.mustStop = true;
    this.desired = undefined;
    this.generation++;
    void this.reconcile();
  }
  dispose() {
    if (this.desired) this.command({ ...this.desired, phase: 'idle' });
  }
  private key(command: SlideTranslationCommand) {
    return `${command.serviceId}:${command.serviceRevision}:${command.segmentId}`;
  }
  private async reconcile() {
    if (this.running) return;
    this.running = true;
    let observed = this.generation;
    try {
      for (;;) {
        observed = this.generation;
        const wanted = this.desired;
        const active = wanted && wanted.phase !== 'idle';
        const key = wanted ? this.key(wanted) : '';
        if (this.owned && (this.mustStop || !active || this.owned.key !== key)) {
          this.io.report({ phase: 'stopping' });
          this.io.disconnect();
          await this.io.stop(this.owned.sessionId);
          this.owned = undefined;
          this.mustStop = false;
          continue;
        }
        if (!active) {
          this.io.disconnect();
          this.io.report(
            this.failure ? { phase: 'error', message: this.failure } : { phase: 'idle' },
          );
          break;
        }
        const cancelled = () =>
          this.desired?.phase === 'idle' || !this.desired || this.key(this.desired) !== key;
        if (!this.owned) {
          this.io.report({ phase: 'preparing' });
          const sessionId = await this.io.prepare(wanted, cancelled);
          // Record ownership even if a Stop arrived while create was in flight.
          this.owned = { key, sessionId, live: false };
          this.mustStop = false;
          continue;
        }
        if (!this.owned.live) {
          await this.io.ready(this.owned.sessionId, cancelled);
          if (cancelled()) continue;
          if (this.desired?.phase === 'live') {
            this.io.report({ phase: 'starting' });
            await this.io.start(this.owned.sessionId);
            this.owned.live = true;
            continue;
          }
          this.io.report({ phase: 'ready' });
        } else if (wanted.phase === 'prepare') {
          // Backing up to before Start disconnects and prepares a fresh session.
          this.io.disconnect();
          await this.io.stop(this.owned.sessionId);
          this.owned = undefined;
          this.mustStop = false;
          continue;
        } else this.io.report({ phase: 'live' });
        if (observed === this.generation) break;
      }
    } catch (error) {
      this.io.disconnect();
      const cause = error instanceof Error ? error.message : 'Translation could not start.';
      // Roll back a partially prepared session; never stop another operator's session.
      if (this.owned) {
        this.mustStop = true;
        try {
          await this.io.stop(this.owned.sessionId);
          this.owned = undefined;
        } catch {
          /* Keep ownership for a later retry. */
        }
      }
      this.io.report({ phase: 'error', message: cause });
    } finally {
      this.running = false;
      if (observed !== this.generation) void this.reconcile();
    }
  }
}
