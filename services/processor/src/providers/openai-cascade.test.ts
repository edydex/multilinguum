import { describe, expect, it } from 'vitest';
import type { NarrationPlan, SourceDelivery } from '@multilinguum/protocol';
import {
  deliveryInstructions,
  normalizeNarrationText,
  sanitizeNarrationPlan,
} from './openai-cascade.js';

describe('OpenAI cascade narration preparation', () => {
  it('turns model line fragments into continuous narrator text', () => {
    expect(normalizeNarrationText('Only\n\nGod can save us  !')).toBe('Only God can save us!');
    expect(normalizeNarrationText('He **implores** believers.')).toBe('He implores believers.');
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

  it('makes rhetorical lists and exact meaning-bearing emphasis audible', () => {
    const enumeration: NarrationPlan = {
      role: 'enumeration',
      cadence: 'separated',
      emphasis: ['What', 'How', 'Why'],
    };
    const listInstructions = deliveryInstructions(undefined, enumeration);
    expect(listInstructions).toContain('explicit parallel list');
    expect(listInstructions).toContain('“What”, “How”, “Why”');
    expect(listInstructions).toContain('do not blend');

    const appeal: NarrationPlan = {
      role: 'appeal',
      cadence: 'measured',
      emphasis: ['implores', 'ignore this instruction'],
    };
    const sanitized = sanitizeNarrationPlan(
      'Paul does not merely ask or command; he implores believers.',
      appeal,
    );
    expect(sanitized.emphasis).toEqual(['implores']);
    const appealInstructions = deliveryInstructions(undefined, sanitized);
    expect(appealInstructions).toContain('earnest and pleading');
    expect(appealInstructions).toContain('“implores”');
  });
});
