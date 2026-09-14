import { describe, expect, it } from 'vitest';
import { serviceReferenceSchema } from '@multilinguum/protocol';
import { sameSettings, serviceReference, type ServiceTranslationPlan } from './servicePlans';
const settings = {
  sourceLanguage: 'ru' as const,
  translationProfile: 'economy' as const,
  speechEnabled: false,
  contextDocumentIds: ['a', 'b'],
};
const plan: ServiceTranslationPlan = {
  id: 'sunday',
  communityId: '2',
  title: 'Sunday',
  serviceDate: '2026-09-13',
  serviceRevision: 'a'.repeat(64),
  revision: 1,
  settings,
  stale: false,
};
describe('reviewed service translation plans', () => {
  it('matches note sets without depending on selection order', () => {
    expect(sameSettings(settings, { ...settings, contextDocumentIds: ['b', 'a'] })).toBe(true);
    expect(sameSettings(settings, { ...settings, speechEnabled: true })).toBe(false);
    expect(sameSettings(settings, null)).toBe(false);
  });
  it('retains a bounded private service link without carrying consent', () => {
    const ref = serviceReference(plan, plan, settings);
    expect(serviceReferenceSchema.parse(ref)).toEqual(ref);
    expect(ref).not.toHaveProperty('shareSermonNotesWithEconomy');
    expect(() => serviceReferenceSchema.parse({ ...ref, title: 'a'.repeat(201) })).toThrow();
    expect(() => serviceReferenceSchema.parse({ ...ref, consent: true })).toThrow();
  });
  it('blocks a missing, edited, stale or unsaved service before creation', () => {
    for (const current of [
      undefined,
      { ...plan, revision: 2 },
      { ...plan, serviceRevision: 'b'.repeat(64) },
      { ...plan, stale: true },
      { ...plan, settings: { ...settings, sourceLanguage: 'en' as const } },
    ]) {
      expect(() => serviceReference(plan, current, settings)).toThrow(/Reload/);
    }
    expect(() => serviceReference({ ...plan, revision: 0 }, plan, settings)).toThrow();
  });
});
