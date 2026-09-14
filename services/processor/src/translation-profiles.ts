import { recognitionRateUsd, usageRatesCheckedOn } from '@multilinguum/protocol';
import type {
  TranslationProfileId,
  TranslationProfileInfo,
  TranslationProvider,
} from '@multilinguum/protocol';
import type { ProcessorConfig } from './config.js';
import { OpenAITextTranslationProvider } from './providers/openai-cascade.js';

export interface ResolvedTranslationProfile {
  info: TranslationProfileInfo;
  provider: TranslationProvider;
}

const textRates: Record<string, readonly [number, number]> = {
  'gpt-6-astra': [10, 50],
  'gpt-5.6-terra': [2, 12],
};

/** No network calls or account-setting changes. Readiness is configuration, not API acceptance. */
export function translationProfileInfo(
  config: ProcessorConfig,
  id: TranslationProfileId,
): TranslationProfileInfo {
  const economy = id === 'economy';
  const textKey = economy
    ? config.OPENAI_ECONOMY_TEXT_API_KEY
    : (config.OPENAI_QUALITY_TEXT_API_KEY ?? config.OPENAI_API_KEY);
  const textModel = economy ? config.OPENAI_ECONOMY_TEXT_MODEL : config.OPENAI_QUALITY_TEXT_MODEL;
  const reasoningEffort = economy
    ? config.OPENAI_ECONOMY_REASONING_EFFORT
    : config.OPENAI_QUALITY_REASONING_EFFORT;
  const rates = textRates[textModel];
  let unavailableReason: string | undefined;
  if (!config.OPENAI_API_KEY) unavailableReason = 'Add the audio API key in server setup.';
  else if (!textKey) unavailableReason = 'Add a separate Economy text-project key in server setup.';
  else if (
    economy &&
    (textKey === config.OPENAI_API_KEY || textKey === config.OPENAI_QUALITY_TEXT_API_KEY)
  )
    unavailableReason =
      'Economy needs a separate text-project key; audio and Quality must use other keys.';
  else if (economy && config.OPENAI_ECONOMY_SHARING_CONFIRMED !== 'true')
    unavailableReason =
      'An administrator must check the text project’s sharing and allowance settings.';
  else if (economy && config.OPENAI_ECONOMY_OVERAGE_POLICY !== 'allow-billed')
    unavailableReason =
      'Economy is blocked: remaining complimentary usage cannot be verified. Allow billed overage in server setup to use it.';
  else if (textModel === 'gpt-6-astra' && reasoningEffort === 'none')
    unavailableReason = 'GPT-6 Astra requires reasoning; set its effort to low in server setup.';
  return {
    id,
    label: economy ? 'Economy · shared-data allowance' : 'Quality',
    ready: !unavailableReason,
    ...(unavailableReason ? { unavailableReason } : {}),
    textModel,
    reasoningEffort,
    transcriptionModel: config.OPENAI_TRANSCRIBE_MODEL,
    speechModel: config.OPENAI_TTS_MODEL,
    sharing:
      economy && config.OPENAI_ECONOMY_SHARING_CONFIRMED === 'true'
        ? 'administrator-confirmed-text-project'
        : 'not-requested',
    allowanceVerified: false,
    overagePolicy: economy ? config.OPENAI_ECONOMY_OVERAGE_POLICY : 'allow-billed',
    qualityValidated: false,
    rates: {
      checkedOn: usageRatesCheckedOn,
      textInputPerMillionUsd: rates?.[0] ?? null,
      textOutputPerMillionUsd: rates?.[1] ?? null,
      transcriptionPerMinuteUsd: recognitionRateUsd(config.OPENAI_TRANSCRIBE_MODEL),
    },
  };
}

export function resolveTranslationProfile(
  config: ProcessorConfig,
  id: TranslationProfileId,
): ResolvedTranslationProfile {
  const info = translationProfileInfo(config, id);
  if (!info.ready) throw new Error(info.unavailableReason);
  const apiKey =
    id === 'economy'
      ? config.OPENAI_ECONOMY_TEXT_API_KEY!
      : (config.OPENAI_QUALITY_TEXT_API_KEY ?? config.OPENAI_API_KEY)!;
  return {
    info,
    provider: new OpenAITextTranslationProvider(apiKey, info.textModel, {
      reasoningEffort: info.reasoningEffort,
      maxOutputTokens: 4096,
    }),
  };
}
