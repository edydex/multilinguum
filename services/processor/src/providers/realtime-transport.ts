import WebSocket, { type RawData } from 'ws';

export type RealtimeEvent = Record<string, unknown> & { type?: string };

export interface RealtimeConnection {
  open(): Promise<void>;
  send(event: unknown): void;
  waitFor(type: string, timeoutMs?: number): Promise<RealtimeEvent>;
  onEvent(listener: (event: RealtimeEvent) => void): () => void;
  close(): void;
}

export type RealtimeConnectionFactory = (input: {
  url: string;
  bearerToken: string;
  safetyIdentifier: string;
}) => RealtimeConnection;

export class WebSocketRealtimeConnection implements RealtimeConnection {
  readonly #socket: WebSocket;
  readonly #listeners = new Set<(event: RealtimeEvent) => void>();
  readonly #waiters = new Map<
    string,
    Array<{ resolve: (event: RealtimeEvent) => void; reject: (error: Error) => void }>
  >();
  #intentionalClose = false;

  constructor(input: { url: string; bearerToken: string; safetyIdentifier: string }) {
    this.#socket = new WebSocket(input.url, {
      headers: {
        Authorization: `Bearer ${input.bearerToken}`,
        'OpenAI-Safety-Identifier': input.safetyIdentifier,
      },
    });
    this.#socket.on('message', (data: RawData) => this.#receive(data));
    this.#socket.on('error', (error) => {
      this.#emitSyntheticError(error.message);
      this.#failWaiters(error);
    });
    this.#socket.on('close', () => {
      const error = new Error('Realtime socket closed.');
      if (!this.#intentionalClose) this.#emitSyntheticError(error.message);
      this.#failWaiters(error);
    });
  }

  async open(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out opening Realtime socket.')),
        15_000,
      );
      this.#socket.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.#socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  send(event: unknown): void {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error('Realtime socket is not open.');
    }
    this.#socket.send(JSON.stringify(event));
  }

  waitFor(type: string, timeoutMs = 30_000): Promise<RealtimeEvent> {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timeout = setTimeout(() => {
        const waiters = this.#waiters.get(type) ?? [];
        this.#waiters.set(
          type,
          waiters.filter((candidate) => candidate !== waiter),
        );
        reject(new Error(`Timed out waiting for ${type}.`));
      }, timeoutMs);
      waiter.resolve = (event) => {
        clearTimeout(timeout);
        resolve(event);
      };
      waiter.reject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      this.#waiters.set(type, [...(this.#waiters.get(type) ?? []), waiter]);
    });
  }

  onEvent(listener: (event: RealtimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#intentionalClose = true;
    if (
      this.#socket.readyState === WebSocket.OPEN ||
      this.#socket.readyState === WebSocket.CONNECTING
    ) {
      this.#socket.close();
    }
  }

  #receive(data: RawData): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(data.toString()) as RealtimeEvent;
    } catch {
      this.#emitSyntheticError('OpenAI sent an invalid JSON event.');
      return;
    }
    for (const listener of this.#listeners) listener(event);
    const waiter = this.#waiters.get(event.type ?? '')?.shift();
    if (waiter) waiter.resolve(event);
  }

  #emitSyntheticError(message: string): void {
    const event: RealtimeEvent = { type: 'error', error: { message } };
    for (const listener of this.#listeners) listener(event);
  }

  #failWaiters(error: Error): void {
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

export const createWebSocketRealtimeConnection: RealtimeConnectionFactory = (input) =>
  new WebSocketRealtimeConnection(input);

export function downsamplePcm48kTo24k(data: Uint8Array): Uint8Array {
  if (data.byteLength % 4 !== 0) {
    throw new Error('48 kHz PCM must contain complete pairs of signed 16-bit samples.');
  }
  const source = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const output = new Uint8Array(data.byteLength / 2);
  const destination = new DataView(output.buffer);
  for (let offset = 0, target = 0; offset < data.byteLength; offset += 4, target += 2) {
    const left = source.getInt16(offset, true);
    const right = source.getInt16(offset + 2, true);
    destination.setInt16(target, Math.round((left + right) / 2), true);
  }
  return output;
}

export function upsamplePcm24kTo48k(data: Uint8Array): Uint8Array {
  if (data.byteLength % 2 !== 0) throw new Error('24 kHz PCM is not 16-bit aligned.');
  const source = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const output = new Uint8Array(data.byteLength * 2);
  const destination = new DataView(output.buffer);
  const sampleCount = data.byteLength / 2;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const current = source.getInt16(sample * 2, true);
    const next = source.getInt16(Math.min(sample + 1, sampleCount - 1) * 2, true);
    destination.setInt16(sample * 4, current, true);
    destination.setInt16(sample * 4 + 2, Math.round((current + next) / 2), true);
  }
  return output;
}
