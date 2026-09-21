import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderUsage, TranscriptSegment } from '@multilinguum/protocol';
import { OpenAINaturalSpeechRenderer, OpenAITextTranslationProvider } from './openai-cascade.js';

afterEach(() => vi.unstubAllGlobals());
const segment: TranscriptSegment = {
  id: 'phrase',
  sessionId: 'test',
  channelId: 'en',
  language: 'en',
  text: 'Grace and peace.',
  sourceStartMs: 0,
  sourceEndMs: 2_000,
  sequence: 1,
  final: true,
  emittedAt: new Date(0).toISOString(),
};

describe('OpenAI usage receipts with the real SDK and local HTTP responses', () => {
  it('records billed text usage before rejecting malformed translation output', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        id: 'response',
        object: 'response',
        service_tier: 'default',
        status: 'completed',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
        },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'invalid JSON' }],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const records: ProviderUsage[] = [];
    const provider = new OpenAITextTranslationProvider('test-key', 'gpt-6-astra');
    await expect(
      provider.translate(segment, {
        sourceLanguage: 'en',
        targetLanguage: 'ru',
        glossary: {},
        precedingText: [],
        recordUsage: (r) => records.push(r),
      }),
    ).rejects.toThrow();
    expect(records.map((r) => r.status)).toEqual(['started', 'completed']);
    expect(records[1]).toMatchObject({
      requestId: records[0]!.requestId,
      kind: 'translation',
      model: 'gpt-6-astra',
      serviceTier: 'default',
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 5,
      outputTokens: 25,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['translation', 'speech'] as const)(
    'records a failed %s attempt without SDK retries',
    async (kind) => {
      const fetch = vi.fn(async () =>
        Response.json({ error: { message: 'Test unavailable' } }, { status: 503 }),
      );
      vi.stubGlobal('fetch', fetch);
      const records: ProviderUsage[] = [];
      const recordUsage = (r: ProviderUsage) => {
        records.push(r);
      };
      const promise =
        kind === 'speech'
          ? new OpenAINaturalSpeechRenderer('test-key', 'gpt-4o-mini-tts').render(
              segment,
              undefined,
              { recordUsage },
            )
          : new OpenAITextTranslationProvider('test-key', 'gpt-6-astra').translate(segment, {
              sourceLanguage: 'en',
              targetLanguage: 'ru',
              glossary: {},
              precedingText: [],
              recordUsage,
            });
      await expect(promise).rejects.toThrow('Test unavailable');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(records.map((r) => r.status)).toEqual(['started', 'failed']);
      expect(records[1]).toMatchObject({ requestId: records[0]!.requestId, kind });
      expect(records[1]!.inputTokens).toBeUndefined();
    },
  );

  it('measures received PCM speech without inventing token counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(48_000))),
    );
    const records: ProviderUsage[] = [];
    const audio = await new OpenAINaturalSpeechRenderer('test-key', 'gpt-4o-mini-tts').render(
      segment,
      undefined,
      { recordUsage: (r) => records.push(r) },
    );
    expect(audio.data.byteLength).toBe(96_000);
    expect(records.map((r) => r.status)).toEqual(['started', 'completed']);
    expect(records[1]).toMatchObject({ generatedAudioSeconds: 1, kind: 'speech' });
    expect(records[1]!.outputTokens).toBeUndefined();
  });

  it('marks malformed PCM as failed rather than leaving it pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(3))),
    );
    const records: ProviderUsage[] = [];
    await expect(
      new OpenAINaturalSpeechRenderer('test-key', 'gpt-4o-mini-tts').render(segment, undefined, {
        recordUsage: (r) => records.push(r),
      }),
    ).rejects.toThrow('incomplete PCM');
    expect(records.map((r) => r.status)).toEqual(['started', 'failed']);
  });
});
