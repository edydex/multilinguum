import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServiceUsageMeter } from '@multilinguum/protocol';
import { ServiceUsagePanel } from './ServiceUsagePanel';

describe('operator usage labels', () => {
  it('makes unpriced work visible even when the known subtotal is zero', () => {
    const meter = new ServiceUsageMeter('custom');
    meter.recordAudio(0, 96_000);
    meter.record({ requestId: 'speech', kind: 'speech', model: 'tts', status: 'started' });
    const html = renderToStaticMarkup(<ServiceUsagePanel usage={meter.snapshot()} />);
    expect(html).toContain('partial');
    expect(html).toContain('cost unavailable');
    expect(html).toContain('including 1 pending');
    expect(html).toContain('Their costs are excluded');
    expect(html).not.toContain('role="status"');
  });

  it('labels reaching the threshold as a reminder that does not stop translation', () => {
    const meter = new ServiceUsageMeter('gpt-transcribe');
    meter.recordAudio(0, 96_000 * 60);
    const html = renderToStaticMarkup(
      <ServiceUsagePanel usage={meter.snapshot()} budgetWarningUsd={0.001} />,
    );
    expect(html).toContain('&lt; $0.01');
    expect(html).toContain('role="status"');
    expect(html).toContain('does not stop spending');
    expect(html).toContain('account bill are not verified');
  });
});
