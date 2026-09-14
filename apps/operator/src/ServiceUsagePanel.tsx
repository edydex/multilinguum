import type { ServiceUsage } from '@multilinguum/protocol';

const dollars = (amount: number) =>
  amount === 0 ? '$0.00' : amount < 0.01 ? '< $0.01' : `$${amount.toFixed(2)}`;
const duration = (seconds: number) =>
  seconds < 60 ? `${Math.round(seconds)} sec` : `${(seconds / 60).toFixed(1)} min`;
const requests = (count: number) => `${count} ${count === 1 ? 'request' : 'requests'}`;

export function ServiceUsagePanel({
  usage,
  budgetWarningUsd,
}: {
  usage: ServiceUsage;
  budgetWarningUsd?: number;
}) {
  return (
    <section className="service-usage" aria-label="Service usage">
      <h3>Service usage</h3>
      <p>
        <strong>{dollars(usage.knownSubtotalUsd)}</strong> estimated{' '}
        {usage.incomplete ? 'partial ' : ''}subtotal
      </p>
      <details>
        <summary>Usage and cost details</summary>
        <dl>
          <dt>Recognition</dt>
          <dd>
            {duration(usage.capturedAudioSeconds)} captured ·{' '}
            {usage.recognitionEstimateUsd === null
              ? 'cost unavailable'
              : `${dollars(usage.recognitionEstimateUsd)} estimated`}
          </dd>
          <dt>Text translation</dt>
          <dd>
            {requests(usage.translationRequests)} · {dollars(usage.knownTranslationListCostUsd)}{' '}
            priced so far
          </dd>
          <dd>
            {usage.inputTokens.toLocaleString('en-US')} input /{' '}
            {usage.outputTokens.toLocaleString('en-US')} output tokens reported
          </dd>
          <dt>Translated speech</dt>
          <dd>
            {requests(usage.speechRequests)} · {duration(usage.generatedAudioSeconds)} generated
            {usage.speechRequests > 0 ? ' · cost unavailable' : ''}
          </dd>
        </dl>
        {usage.requestsWithoutPrice > 0 && (
          <p className="hint">
            {requests(usage.requestsWithoutPrice)}{' '}
            {usage.requestsWithoutPrice === 1 ? 'has' : 'have'} no price yet, including{' '}
            {usage.pendingRequests} pending. Their costs are excluded.
          </p>
        )}
        <p className="hint">
          This service only, using list rates checked {usage.ratesCheckedOn}. Recognition uses
          captured duration; text uses reported tokens. Speech responses do not report enough usage
          to price them. Shared-data allowance and your account bill are not verified.
        </p>
      </details>
      {budgetWarningUsd !== undefined && usage.knownSubtotalUsd >= budgetWarningUsd && (
        <p className="notice" role="status">
          The known subtotal has reached the ${budgetWarningUsd.toFixed(2)} reminder. Translation is
          still running; this reminder does not stop spending.
        </p>
      )}
    </section>
  );
}
