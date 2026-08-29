import { describe, expect, it } from 'vitest';
import type { SessionEngine } from './session-engine.js';
import { CapturePipeline, type ChunkTranscriber } from './capture-pipeline.js';

describe('capture pipeline timing', () => {
  it('preserves capture time and measures the transcription stage separately', async () => {
    const sourceAudio: unknown[] = [];
    const transcripts: Array<{
      timing?: {
        captureCompletedAtUnixMs?: number;
        transcriptionEngine?: string;
        transcription?: { startedAtUnixMs: number; completedAtUnixMs: number };
      };
    }> = [];
    const engine = {
      ingestSourceAudio: async (input: unknown) => {
        sourceAudio.push(input);
      },
      ingestTranscript: async (input: (typeof transcripts)[number]) => {
        transcripts.push(input);
        return [];
      },
    } as unknown as SessionEngine;
    const transcriber: ChunkTranscriber = {
      name: 'test-live-transcriber',
      transcribe: async () => 'Благодать вам и мир.',
    };
    const pipeline = new CapturePipeline(engine, transcriber, 'ru');
    const capturedAtUnixMs = Date.now() - 20;

    pipeline.push(new Uint8Array(48_000 * 5 * 2), capturedAtUnixMs);
    await pipeline.close();

    expect(sourceAudio).toHaveLength(1);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.timing?.captureCompletedAtUnixMs).toBe(capturedAtUnixMs);
    expect(transcripts[0]?.timing?.transcriptionEngine).toBe('test-live-transcriber');
    expect(transcripts[0]?.timing?.transcription?.completedAtUnixMs).toBeGreaterThanOrEqual(
      transcripts[0]?.timing?.transcription?.startedAtUnixMs ?? Number.POSITIVE_INFINITY,
    );
  });
});
