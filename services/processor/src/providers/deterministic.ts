import type {
  Language,
  RenderedSpeech,
  SpeechRenderer,
  TranscriptSegment,
  TranslationContext,
  TranslationProvider,
  VoiceProfile,
} from '@multilinguum/protocol';

const examples: Record<string, Partial<Record<Language, string>>> = {
  'Благодать вам и мир от Бога Отца нашего.': {
    en: 'Grace to you and peace from God our Father.',
    es: 'Gracia y paz a ustedes de parte de Dios nuestro Padre.',
    uk: 'Благодать вам і мир від Бога, Отця нашого.',
  },
  'Grace to you and peace from God our Father.': {
    ru: 'Благодать вам и мир от Бога Отца нашего.',
    es: 'Gracia y paz a ustedes de parte de Dios nuestro Padre.',
    uk: 'Благодать вам і мир від Бога, Отця нашого.',
  },
};

export class DeterministicTranslationProvider implements TranslationProvider {
  readonly name = 'deterministic-translation';

  async translate(
    segment: TranscriptSegment,
    context: TranslationContext,
  ): Promise<TranscriptSegment> {
    const known = examples[segment.text]?.[context.targetLanguage];
    const text = known ?? `[${context.targetLanguage.toUpperCase()}] ${segment.text}`;
    return {
      ...segment,
      id: `${segment.id}-${context.targetLanguage}`,
      channelId: context.targetLanguage,
      language: context.targetLanguage,
      text,
      emittedAt: new Date().toISOString(),
    };
  }
}

export class DeterministicSpeechRenderer implements SpeechRenderer {
  readonly name = 'deterministic-no-audio';

  async render(segment: TranscriptSegment, _profile?: VoiceProfile): Promise<RenderedSpeech> {
    return {
      data: new Uint8Array(),
      encoding: 'pcm_s16le',
      sampleRate: 48000,
      startMs: segment.sourceStartMs,
      endMs: segment.sourceEndMs,
      sequence: segment.sequence,
      language: segment.language,
      renderer: this.name,
    };
  }

  async health(): Promise<{ ready: boolean; detail?: string }> {
    return {
      ready: true,
      detail: 'Control/transcript test provider; it intentionally emits no audio.',
    };
  }
}
