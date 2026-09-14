import { describe, expect, it } from 'vitest';
import { ServiceUsageMeter, translationListCostUsd, type ProviderUsage } from './usage.js';

const receipt = (overrides: Partial<ProviderUsage> = {}): ProviderUsage => ({
  requestId: 'text-1',
  kind: 'translation',
  model: 'gpt-6-astra',
  status: 'completed',
  serviceTier: 'default',
  inputTokens: 1_000,
  cachedInputTokens: 200,
  cacheWriteInputTokens: 100,
  outputTokens: 50,
  ...overrides,
});

describe('private observed service usage', () => {
  it('prices uncached, cached, cache-write and output tokens at the selected list rates', () => {
    expect(translationListCostUsd(receipt())).toBeCloseTo(0.01095, 10);
    expect(translationListCostUsd(receipt({ model: 'gpt-5.6-terra' }))).toBeCloseTo(0.00229, 10);
    expect(
      translationListCostUsd(
        receipt({ inputTokens: 272_001, cachedInputTokens: 0, cacheWriteInputTokens: 0 }),
      ),
    ).toBeCloseTo(5.44377, 10);
    expect(
      translationListCostUsd(
        receipt({ inputTokens: 272_000, cachedInputTokens: 0, cacheWriteInputTokens: 0 }),
      ),
    ).toBeCloseTo(2.7225, 10);
  });

  it.each([
    { model: 'unknown' },
    { serviceTier: undefined },
    { serviceTier: 'priority' },
    { serviceTier: 'flex' },
    { status: 'failed' },
    { status: 'started' },
    { inputTokens: NaN },
    { outputTokens: -1 },
    { outputTokens: 0.5 },
    { cachedInputTokens: undefined },
    { cacheWriteInputTokens: undefined },
    { cachedInputTokens: 1_000 },
    { kind: 'speech' },
  ] satisfies Partial<ProviderUsage>[])(
    'does not turn unknown or invalid usage into a zero price: %j',
    (change) => {
      expect(translationListCostUsd(receipt(change))).toBeNull();
    },
  );

  it('deduplicates captured frames and receipts without overwriting a completed request', () => {
    const meter = new ServiceUsageMeter('gpt-transcribe');
    meter.recordAudio(0, 5_760_000);
    meter.recordAudio(0, 5_760_000);
    meter.recordAudio(-1, 5_760_000);
    meter.record(receipt({ status: 'started' }));
    meter.record(receipt());
    meter.record(receipt({ status: 'started' }));
    meter.record(receipt({ outputTokens: 999_999 }));
    expect(meter.snapshot()).toMatchObject({
      capturedAudioSeconds: 60,
      recognitionEstimateUsd: 0.0045,
      translationRequests: 1,
      speechRequests: 0,
      pendingRequests: 0,
      requestsWithoutPrice: 0,
      inputTokens: 1_000,
      outputTokens: 50,
      incomplete: false,
    });
    expect(meter.snapshot().knownSubtotalUsd).toBeCloseTo(0.01545, 10);
  });

  it('keeps speech, failed and pending requests unpriced even when text has a price', () => {
    const meter = new ServiceUsageMeter('gpt-live-transcribe');
    meter.recordAudio(1, 5_760_000);
    meter.record(receipt());
    meter.record(
      receipt({
        requestId: 'pending',
        status: 'started',
        inputTokens: undefined,
        outputTokens: undefined,
      }),
    );
    meter.record(
      receipt({
        requestId: 'failed',
        status: 'failed',
        inputTokens: undefined,
        outputTokens: undefined,
      }),
    );
    meter.record({
      requestId: 'speech',
      kind: 'speech',
      model: 'gpt-4o-mini-tts',
      status: 'completed',
      generatedAudioSeconds: 6,
    });
    expect(meter.snapshot()).toMatchObject({
      translationRequests: 3,
      speechRequests: 1,
      pendingRequests: 1,
      requestsWithoutPrice: 3,
      inputTokens: 1_000,
      outputTokens: 50,
      generatedAudioSeconds: 6,
      incomplete: true,
    });
    expect(meter.snapshot().knownSubtotalUsd).toBeCloseTo(0.02795, 10);
  });

  it('leaves unknown recognition unpriced, and ignores a mismatched terminal receipt', () => {
    const meter = new ServiceUsageMeter('custom-recognizer');
    expect(meter.snapshot().incomplete).toBe(false);
    meter.recordAudio(0, 96_000);
    meter.record(receipt({ status: 'started', inputTokens: undefined, outputTokens: undefined }));
    meter.record(receipt({ model: 'gpt-5.6-terra' }));
    expect(meter.snapshot()).toMatchObject({
      recognitionEstimateUsd: null,
      knownSubtotalUsd: 0,
      pendingRequests: 1,
      incomplete: true,
    });
    expect(new ServiceUsageMeter('gpt-transcribe').snapshot().translationRequests).toBe(0);
  });
});
