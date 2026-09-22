import type { ServiceReference } from '@multilinguum/protocol';
export interface TranslationSettings {
  transcriptionProvider?: 'auto' | 'muse' | 'openai';
  sourceLanguage: 'en' | 'ru';
  translationProfile: 'quality' | 'economy';
  shareSermonNotesWithEconomy?: boolean;
  speechEnabled: boolean;
  contextDocumentIds: string[];
}
export interface ServiceTranslationPlan {
  id: string;
  communityId: string;
  title: string;
  serviceDate: string;
  serviceRevision: string;
  revision: number;
  settings: TranslationSettings | null;
  stale: boolean;
}
export interface ServicePlanOptions {
  preferredServiceId?: string;
  loadServicePlans?(
    serviceId?: string,
  ): Promise<{ schemaVersion: 1; services: ServiceTranslationPlan[] }>;
  saveServicePlan?(input: {
    serviceId: string;
    serviceRevision: string;
    baseRevision: number;
    settings: TranslationSettings;
  }): Promise<{ schemaVersion: 1; service: ServiceTranslationPlan }>;
}
export function sameSettings(
  left: TranslationSettings,
  right: TranslationSettings | null,
): boolean {
  return Boolean(
    right &&
    left.sourceLanguage === right.sourceLanguage &&
    left.translationProfile === right.translationProfile &&
    (left.transcriptionProvider ?? 'auto') === (right.transcriptionProvider ?? 'auto') &&
    left.speechEnabled === right.speechEnabled &&
    Boolean(left.shareSermonNotesWithEconomy) === Boolean(right.shareSermonNotesWithEconomy) &&
    JSON.stringify([...left.contextDocumentIds].sort()) ===
      JSON.stringify([...right.contextDocumentIds].sort()),
  );
}
export function serviceReference(
  selected: ServiceTranslationPlan,
  current: ServiceTranslationPlan | undefined,
  settings: TranslationSettings,
): ServiceReference {
  if (
    !current ||
    !selected.revision ||
    current.stale ||
    current.serviceRevision !== selected.serviceRevision ||
    current.revision !== selected.revision ||
    !sameSettings(settings, current.settings)
  ) {
    throw new Error(
      'This service or its translation settings changed. Reload the service, review, and save before starting.',
    );
  }
  return {
    communityId: current.communityId,
    serviceId: current.id,
    title: current.title,
    serviceDate: current.serviceDate,
    serviceRevision: current.serviceRevision,
    planRevision: current.revision,
  };
}
