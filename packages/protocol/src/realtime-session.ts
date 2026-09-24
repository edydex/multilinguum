import type { ChannelConfig } from './types.js';

/** Cue-driven interpretation is a native audio stream, not a cascade cost profile. */
export function realtimeInterpretationOptions(sourceLanguage: 'en' | 'ru', speechEnabled: boolean) {
  return {
    transcriptionProvider: 'openai' as const,
    sourceLanguage,
    translationProfile: undefined,
    targets: (['en', 'ru'] as const).map((language): ChannelConfig => ({
      id: `channel-${language}`,
      targetLanguage: language,
      translationProvider: language === sourceLanguage ? 'deterministic' : 'openai-realtime',
      voiceMode: language === sourceLanguage ? 'source' : 'natural',
      fallbackOrder: ['mute'],
      muted: false,
      speechEnabled: language !== sourceLanguage && speechEnabled,
    })),
  };
}
