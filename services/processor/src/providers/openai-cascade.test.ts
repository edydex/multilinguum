import { describe, expect, it } from 'vitest';
import type { SourceDelivery } from '@multilinguum/protocol';
import { deliveryInstructions, normalizeNarrationText } from './openai-cascade.js';

describe('OpenAI cascade narration preparation', () => {
  it('turns model line fragments into continuous narrator text', () => {
    expect(normalizeNarrationText('Only\n\nGod can save us  !')).toBe('Only God can save us!');
  });

  it('turns source delivery measurements into bounded speech direction', () => {
    const delivery: SourceDelivery = {
      pace: 'animated',
      energy: 'emphatic',
      contour: 'continuation',
    };
    const instructions = deliveryInstructions(delivery);
    expect(instructions).toContain('do not speed up');
    expect(instructions).toContain('controlled emphasis');
    expect(instructions).toContain('connected to the following thought');
  });
});
