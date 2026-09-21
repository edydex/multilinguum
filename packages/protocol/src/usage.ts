/** Private provider accounting, never attached to public captions or audio. */
export interface ProviderUsage {
  requestId: string;
  kind: 'translation' | 'speech';
  model: string;
  status: 'started' | 'completed' | 'failed';
  serviceTier?: string | undefined;
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheWriteInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  generatedAudioSeconds?: number | undefined;
}

export interface ServiceUsage {
  /** Local measurements and provider-reported tokens; not the account invoice. */
  basis: 'observed-service-usage';
  ratesCheckedOn: string;
  capturedAudioSeconds: number;
  recognitionEstimateUsd: number | null;
  translationRequests: number;
  speechRequests: number;
  pendingRequests: number;
  requestsWithoutPrice: number;
  inputTokens: number;
  outputTokens: number;
  generatedAudioSeconds: number;
  knownTranslationListCostUsd: number;
  /** Recognition estimate plus priced text requests; excludes all unpriced work. */
  knownSubtotalUsd: number;
  incomplete: boolean;
}

export const usageRatesCheckedOn = '2026-09-14';

export function recognitionRateUsd(model: string): number | null {
  // Meta's published $0.18/hour rate, checked 2026-09-20.
  if (model === 'muse-voice-transcribe-1.0') return 0.003;
  if (model === 'gpt-transcribe') return 0.0045;
  if (model === 'gpt-live-transcribe' || model === 'gpt-realtime-whisper') return 0.017;
  return null;
}

const textRates: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
};
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Standard list price only. Unknown tiers, missing usage and custom models stay unpriced. */
export function translationListCostUsd(usage: ProviderUsage): number | null {
  const rate = textRates[usage.model];
  if (
    usage.kind !== 'translation' ||
    usage.status !== 'completed' ||
    !rate ||
    usage.serviceTier !== 'default' ||
    !count(usage.inputTokens) ||
    !count(usage.outputTokens) ||
    !count(usage.cachedInputTokens) ||
    !count(usage.cacheWriteInputTokens) ||
    usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens
  )
    return null;
  const longContext = usage.inputTokens > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const uncached = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  return (
    ((uncached * rate.input +
      usage.cachedInputTokens * rate.cached +
      usage.cacheWriteInputTokens * rate.input * 1.25) *
      inputMultiplier +
      usage.outputTokens * rate.output * outputMultiplier) /
    1_000_000
  );
}

export class ServiceUsageMeter {
  readonly #requests = new Map<string, ProviderUsage>();
  readonly #sourceSequences = new Set<number>();
  #capturedAudioSeconds = 0;

  constructor(readonly recognitionModel: string) {}

  recordAudio(sequence: number, pcmBytes: number): void {
    if (!count(sequence) || !count(pcmBytes) || this.#sourceSequences.has(sequence)) return;
    this.#sourceSequences.add(sequence);
    this.#capturedAudioSeconds += pcmBytes / (48_000 * 2);
  }

  record(usage: ProviderUsage): void {
    const previous = this.#requests.get(usage.requestId);
    // A duplicate/late start must never replace a priced terminal receipt.
    if (previous && previous.status !== 'started') return;
    if (previous && (previous.model !== usage.model || previous.kind !== usage.kind)) return;
    this.#requests.set(usage.requestId, { ...usage });
  }

  snapshot(): ServiceUsage {
    const records = [...this.#requests.values()];
    const rate = recognitionRateUsd(this.recognitionModel);
    const recognitionEstimateUsd =
      this.#capturedAudioSeconds === 0
        ? 0
        : rate === null
          ? null
          : (this.#capturedAudioSeconds / 60) * rate;
    let knownTranslationListCostUsd = 0;
    let requestsWithoutPrice = 0;
    for (const receipt of records) {
      const price = translationListCostUsd(receipt);
      if (price === null) requestsWithoutPrice += 1;
      else knownTranslationListCostUsd += price;
    }
    const sum = (key: 'inputTokens' | 'outputTokens') =>
      records.reduce(
        (total, row) => total + (row.kind === 'translation' && count(row[key]) ? row[key]! : 0),
        0,
      );
    return {
      basis: 'observed-service-usage',
      ratesCheckedOn: usageRatesCheckedOn,
      capturedAudioSeconds: this.#capturedAudioSeconds,
      recognitionEstimateUsd,
      translationRequests: records.filter((r) => r.kind === 'translation').length,
      speechRequests: records.filter((r) => r.kind === 'speech').length,
      pendingRequests: records.filter((r) => r.status === 'started').length,
      requestsWithoutPrice,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      generatedAudioSeconds: records.reduce(
        (sum, row) =>
          sum +
          (row.kind === 'speech' &&
          row.status === 'completed' &&
          Number.isFinite(row.generatedAudioSeconds) &&
          row.generatedAudioSeconds! >= 0
            ? row.generatedAudioSeconds!
            : 0),
        0,
      ),
      knownTranslationListCostUsd,
      knownSubtotalUsd: knownTranslationListCostUsd + (recognitionEstimateUsd ?? 0),
      incomplete: recognitionEstimateUsd === null || requestsWithoutPrice > 0,
    };
  }
}
