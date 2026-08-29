import type { OpenAIChunkTranscriber } from './providers/openai-chunk-transcriber.js';
import type { SessionEngine } from './session-engine.js';

const samplesPerChunk = 48_000 * 5;
const bytesPerSample = 2;

export class CapturePipeline {
  readonly #engine: SessionEngine;
  readonly #transcriber: OpenAIChunkTranscriber;
  readonly #sourceLanguage: 'en' | 'ru';
  #pending = new Uint8Array();
  #processedSamples = 0;
  #sequence = 0;
  #chain = Promise.resolve();

  constructor(
    engine: SessionEngine,
    transcriber: OpenAIChunkTranscriber,
    sourceLanguage: 'en' | 'ru',
  ) {
    this.#engine = engine;
    this.#transcriber = transcriber;
    this.#sourceLanguage = sourceLanguage;
  }

  push(frame: Uint8Array): void {
    if (frame.byteLength % bytesPerSample !== 0)
      throw new Error('PCM frame is not 16-bit aligned.');
    const combined = new Uint8Array(this.#pending.byteLength + frame.byteLength);
    combined.set(this.#pending);
    combined.set(frame, this.#pending.byteLength);
    this.#pending = combined;
    while (this.#pending.byteLength >= samplesPerChunk * bytesPerSample) {
      const bytes = samplesPerChunk * bytesPerSample;
      const chunk = this.#pending.slice(0, bytes);
      this.#pending = this.#pending.slice(bytes);
      this.#enqueue(chunk);
    }
  }

  async close(): Promise<void> {
    if (this.#pending.byteLength >= 48_000 * bytesPerSample) {
      this.#enqueue(this.#pending);
      this.#pending = new Uint8Array();
    }
    await this.#chain;
  }

  #enqueue(data: Uint8Array): void {
    const startMs = Math.round((this.#processedSamples / 48_000) * 1_000);
    const samples = data.byteLength / bytesPerSample;
    this.#processedSamples += samples;
    const endMs = Math.round((this.#processedSamples / 48_000) * 1_000);
    const sequence = this.#sequence++;
    this.#chain = this.#chain.then(async () => {
      await this.#engine.ingestSourceAudio({
        data,
        startMs,
        endMs,
        sequence,
        language: this.#sourceLanguage,
      });
      const text = await this.#transcriber.transcribe(data, this.#sourceLanguage);
      if (text) {
        await this.#engine.ingestTranscript({
          text,
          sourceStartMs: startMs,
          sourceEndMs: endMs,
          final: true,
          sequence,
        });
      }
    });
  }
}
