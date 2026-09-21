import type { ServiceSession } from '@multilinguum/protocol';
import type { ProcessorConfig } from './config.js';
import { MUSE_TRANSCRIPTION_MODEL } from './providers/muse-live-transcriber.js';

export function selectTranscription(
  config: ProcessorConfig,
  language: 'en' | 'ru',
  requested = config.TRANSCRIPTION_PROVIDER,
): NonNullable<ServiceSession['transcription']> {
  if (requested === 'muse' && language !== 'en')
    return {
      provider: 'muse',
      model: MUSE_TRANSCRIPTION_MODEL,
      ready: false,
      detail: 'Muse does not support Russian. Choose Automatic or OpenAI for Russian.',
    };
  if (requested === 'muse' || (requested === 'auto' && language === 'en' && config.MUSE_API_KEY))
    return {
      provider: 'muse',
      model: MUSE_TRANSCRIPTION_MODEL,
      ready: Boolean(config.MUSE_API_KEY),
      detail: config.MUSE_API_KEY
        ? 'Muse recognizes English; the selected translation profile translates the transcript.'
        : 'Add a Muse API token to use Muse transcription.',
    };
  return {
    provider: 'openai',
    model: config.OPENAI_TRANSCRIBE_MODEL,
    ready: Boolean(config.OPENAI_API_KEY),
    detail: !config.OPENAI_API_KEY
      ? 'Add an OpenAI audio API key to transcribe this source.'
      : language === 'ru' && requested === 'auto'
        ? 'Russian uses OpenAI because Muse does not support Russian.'
        : requested === 'auto'
          ? 'OpenAI is used until a Muse API token is configured.'
          : 'OpenAI transcription selected.',
  };
}
