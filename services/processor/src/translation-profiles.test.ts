import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '@multilinguum/protocol';
import { loadConfig } from './config.js';
import { resolveTranslationProfile, translationProfileInfo } from './translation-profiles.js';

const configured = {
  OPENAI_API_KEY: 'test-audio-key',
  OPENAI_QUALITY_TEXT_API_KEY: 'test-quality-key',
  OPENAI_ECONOMY_TEXT_API_KEY: 'test-sharing-key',
  OPENAI_ECONOMY_SHARING_CONFIRMED: 'true',
  OPENAI_ECONOMY_OVERAGE_POLICY: 'allow-billed',
};
afterEach(() => vi.unstubAllGlobals());

describe('translation profile configuration and request boundaries', () => {
  it('blocks missing keys, unconfirmed sharing, and unapproved overage without fallback', () => {
    expect(translationProfileInfo(loadConfig({}), 'quality').ready).toBe(false);
    for (const overrides of [
      { OPENAI_ECONOMY_TEXT_API_KEY: '' },
      { OPENAI_ECONOMY_SHARING_CONFIRMED: 'false' },
      { OPENAI_ECONOMY_OVERAGE_POLICY: 'block' },
      { OPENAI_ECONOMY_TEXT_API_KEY: configured.OPENAI_API_KEY },
      { OPENAI_ECONOMY_TEXT_API_KEY: configured.OPENAI_QUALITY_TEXT_API_KEY },
    ]) {
      const config = loadConfig({ ...configured, ...overrides });
      expect(translationProfileInfo(config, 'economy').ready).toBe(false);
      expect(() => resolveTranslationProfile(config, 'economy')).toThrow();
    }
  });

  it('exposes no credentials, never claims allowance or quality verification, and labels unknown prices', () => {
    const info = translationProfileInfo(loadConfig(configured), 'economy');
    expect(info).toMatchObject({ ready: true, allowanceVerified: false, qualityValidated: false });
    for (const key of ['test-audio-key', 'test-quality-key', 'test-sharing-key'])
      expect(JSON.stringify(info)).not.toContain(key);
    expect(
      translationProfileInfo(
        loadConfig({ ...configured, OPENAI_ECONOMY_TEXT_MODEL: 'custom-model' }),
        'economy',
      ).rates.textInputPerMillionUsd,
    ).toBeNull();
    expect(
      translationProfileInfo(
        loadConfig({ ...configured, OPENAI_QUALITY_REASONING_EFFORT: 'none' }),
        'quality',
      ).ready,
    ).toBe(false);
  });

  it.each(['quality', 'economy'] as const)(
    'uses only the selected %s key and model in the real SDK request',
    async (id) => {
      const fetch = vi.fn(async (_url: unknown, _init: unknown) =>
        Response.json({
          id: 'resp_fixture',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_fixture',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  annotations: [],
                  text: JSON.stringify({
                    translation: 'Благодать и мир вам.',
                    narrationPlan: {
                      role: 'neutral',
                      cadence: 'flowing',
                      arc: 'standalone',
                      pauseBefore: 'none',
                      pauseAfter: 'full',
                      emphasis: [],
                      beats: [],
                    },
                  }),
                },
              ],
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetch);
      const { provider } = resolveTranslationProfile(loadConfig(configured), id);
      const segment: TranscriptSegment = {
        id: 'source-1',
        sessionId: 'test',
        channelId: 'source-en',
        language: 'en',
        text: 'Grace and peace to you.',
        sourceStartMs: 0,
        sourceEndMs: 2000,
        sequence: 0,
        final: true,
        emittedAt: new Date().toISOString(),
      };
      const result = await provider.translate(segment, {
        sourceLanguage: 'en',
        targetLanguage: 'ru',
        glossary: {},
        precedingText: [],
      });
      expect(result.text).toBe('Благодать и мир вам.');
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0]!;
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      const request = init as RequestInit;
      expect(new Headers(request.headers).get('authorization')).toBe(
        id === 'economy' ? 'Bearer test-sharing-key' : 'Bearer test-quality-key',
      );
      expect(JSON.parse(request.body as string)).toMatchObject({
        model: id === 'economy' ? 'gpt-5.6-terra' : 'gpt-6-astra',
        reasoning: { effort: id === 'economy' ? 'none' : 'low' },
        max_output_tokens: 4096,
        store: false,
      });
    },
  );

  it('does not retry or silently use Quality when the Economy provider rejects a request', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { message: 'Fixture quota exceeded', type: 'insufficient_quota' } },
        { status: 429 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const { provider } = resolveTranslationProfile(loadConfig(configured), 'economy');
    await expect(
      provider.translate({ text: 'Test.' } as TranscriptSegment, {
        sourceLanguage: 'en',
        targetLanguage: 'ru',
        glossary: {},
        precedingText: [],
      }),
    ).rejects.toThrow('Fixture quota exceeded');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
