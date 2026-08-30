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

  it('does not turn a rhetorical setup into an audible trailing-off ellipsis', () => {
    const setup: NarrationPlan = {
      role: 'contrast',
      cadence: 'flowing',
      arc: 'setup',
      pauseBefore: 'none',
      pauseAfter: 'connected',
      emphasis: [],
      beats: [{ text: 'what we', function: 'setup', strength: 'restrained' }],
    };
    expect(normalizeNarrationText('but first of all with what we...', setup)).toBe(
      'but first of all with what we',
    );
    expect(deliveryInstructions(undefined, setup)).toContain('without trailing off or fading');
  });

  it('turns source delivery measurements into bounded speech direction', () => {
    const delivery: SourceDelivery = {
      pace: 'animated',
      energy: 'emphatic',
      contour: 'continuation',
    };
    const instructions = deliveryInstructions(delivery);
    expect(instructions).toContain('broadly animated');
    expect(instructions).toContain('broad intensity');
    expect(instructions).toContain('natural target-language prosody');
    expect(instructions).toContain('do not imitate source-language pitch movement');
  });

  it('makes rhetorical lists and exact meaning-bearing emphasis audible', () => {
    const enumeration: NarrationPlan = {
      role: 'enumeration',
      cadence: 'separated',
      arc: 'standalone',
      pauseBefore: 'none',
      pauseAfter: 'full',
      emphasis: ['What', 'How', 'Why'],
      beats: [
        { text: 'What?', function: 'parallel', strength: 'normal' },
        { text: 'How?', function: 'parallel', strength: 'normal' },
        { text: 'Why?', function: 'resolution', strength: 'strong' },
      ],
    };
    const listInstructions = deliveryInstructions(undefined, enumeration);
    expect(listInstructions).toContain('explicit parallel list');
    expect(listInstructions).toContain('“What”, “How”, “Why”');
    expect(listInstructions).toContain('do not blend');

    const appeal: NarrationPlan = {
      role: 'appeal',
      cadence: 'measured',
      arc: 'climax',
      pauseBefore: 'brief',
      pauseAfter: 'full',
      emphasis: ['implores', 'ignore this instruction'],
      beats: [
        { text: 'Paul does not merely ask', function: 'setup', strength: 'restrained' },
        { text: 'implores believers', function: 'climax', strength: 'strong' },
        { text: 'ignore this instruction', function: 'climax', strength: 'strong' },
      ],
    };
    const sanitized = sanitizeNarrationPlan(
      'Paul does not merely ask or command; he implores believers.',
      appeal,
    );
    expect(sanitized.emphasis).toEqual(['implores']);
    expect(sanitized.beats.map((beat) => beat.text)).toEqual([
      'Paul does not merely ask',
      'implores believers',
    ]);
    const appealInstructions = deliveryInstructions(undefined, sanitized);
    expect(appealInstructions).toContain('earnest and pleading');
    expect(appealInstructions).toContain('“implores”');
    expect(appealInstructions).toContain('semantic climax');
    expect(appealInstructions).toContain('Never copy the source language’s pitch contour');
  });

  it('keeps contrast setup open for a later English climax', () => {
    const setup: NarrationPlan = {
      role: 'contrast',
      cadence: 'flowing',
      arc: 'setup',
      pauseBefore: 'none',
      pauseAfter: 'connected',
      emphasis: [],
      beats: [{ text: 'Paul does not merely ask', function: 'setup', strength: 'restrained' }],
    };
    const instructions = deliveryInstructions(
      { pace: 'measured', energy: 'balanced', contour: 'statement' },
      setup,
    );
    expect(instructions).toContain('restrained setup');
    expect(instructions).toContain('Keep the ending connected');
    expect(instructions).not.toContain('falling cadence');
  });
});
