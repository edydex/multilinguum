import OpenAI from 'openai';
import type {
  RenderedSpeech,
  SpeechRenderer,
  TranscriptSegment,
  TranslationContext,
  TranslationProvider,
  VoiceProfile,
} from '@multilinguum/protocol';

function glossaryText(glossary: Readonly<Record<string, string>>): string {
  return Object.entries(glossary)
    .map(([source, target]) => `${source} => ${target}`)
    .join('\n');
}

export class OpenAITextTranslationProvider implements TranslationProvider {
  readonly name: string;
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(apiKey: string, model: string) {
    this.#client = new OpenAI({ apiKey });
    this.#model = model;
    this.name = `openai-responses:${model}`;
  }

  async translate(
    segment: TranscriptSegment,
    context: TranslationContext,
  ): Promise<TranscriptSegment> {
    const response = await this.#client.responses.create({
      model: this.#model,
      instructions:
        'Translate church sermon speech faithfully. Preserve Scripture meaning, names, numbers, ' +
        'sentence restarts, and emphasis. Never add commentary. Return only the translation.',
      input: [
        `Source language: ${context.sourceLanguage}`,
        `Target language: ${context.targetLanguage}`,
        `Terminology:\n${glossaryText(context.glossary)}`,
        `Prior context:\n${context.precedingText.slice(-4).join('\n')}`,
        `Translate:\n${segment.text}`,
      ].join('\n\n'),
    });
    const text = response.output_text.trim();
    if (!text) {
      throw new Error('OpenAI returned an empty translation.');
    }
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

export class OpenAINaturalSpeechRenderer implements SpeechRenderer {
  readonly name: string;
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(apiKey: string, model: string) {
    this.#client = new OpenAI({ apiKey });
    this.#model = model;
    this.name = `openai-tts:${model}`;
  }

  async render(segment: TranscriptSegment, _profile?: VoiceProfile): Promise<RenderedSpeech> {
    const response = await this.#client.audio.speech.create({
      model: this.#model,
      voice: 'cedar',
      input: segment.text,
      response_format: 'pcm',
      instructions:
        'Warm, clear church interpretation. Follow the source punctuation and emphasis without dramatizing.',
    });
    const pcm24k = new Int16Array(await response.arrayBuffer());
    const pcm48k = new Int16Array(pcm24k.length * 2);
    for (let index = 0; index < pcm24k.length; index += 1) {
      const current = pcm24k[index] ?? 0;
      const next = pcm24k[index + 1] ?? current;
      pcm48k[index * 2] = current;
      pcm48k[index * 2 + 1] = Math.round((current + next) / 2);
    }
    return {
      data: new Uint8Array(pcm48k.buffer),
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
      detail: 'Credentials are configured; a live request is required to verify access.',
    };
  }
}
