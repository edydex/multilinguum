import { describe, expect, it } from 'vitest';
import { channelConfigSchema, estimateCloudServiceCost } from './index.js';

describe('channel configuration', () => {
  it('requires a consented profile identifier for cloned voice', () => {
    const result = channelConfigSchema.safeParse({
      id: 'en',
      targetLanguage: 'en',
      translationProvider: 'openai-cascade',
      voiceMode: 'cloned',
      fallbackOrder: ['natural', 'mute'],
      muted: false,
    });

    expect(result.success).toBe(false);
  });
});

describe('service estimate', () => {
  it('matches the four-channel, two-hour planning baseline', () => {
    const channels = ['en', 'es', 'uk'].map((targetLanguage) => ({
      id: targetLanguage,
      targetLanguage: targetLanguage as 'en' | 'es' | 'uk',
      translationProvider: 'openai-realtime' as const,
      voiceMode: 'natural' as const,
      fallbackOrder: ['mute' as const],
      muted: false,
    }));

    expect(estimateCloudServiceCost(120, channels)).toBe(14.28);
  });
});
