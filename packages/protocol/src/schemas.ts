import { z } from 'zod';

export const languageSchema = z.enum(['en', 'ru', 'es', 'uk']);
export const sourceLanguageSchema = z.enum(['en', 'ru']);
export const voiceModeSchema = z.enum(['source', 'natural', 'cloned']);
export const providerKindSchema = z.enum([
  'openai-realtime',
  'openai-cascade',
  'local',
  'deterministic',
]);

export const channelConfigSchema = z
  .object({
    id: z.string().min(1),
    targetLanguage: languageSchema,
    translationProvider: providerKindSchema,
    voiceMode: voiceModeSchema,
    voiceProfileId: z.string().min(1).optional(),
    fallbackOrder: z.array(z.enum(['natural', 'cloned', 'mute'])).min(1),
    muted: z.boolean(),
  })
  .superRefine((channel, context) => {
    if (channel.voiceMode === 'cloned' && !channel.voiceProfileId) {
      context.addIssue({
        code: 'custom',
        path: ['voiceProfileId'],
        message: 'A cloned channel requires a consented voice profile.',
      });
    }
  });

export const createSessionSchema = z.object({
  sourceLanguage: sourceLanguageSchema,
  targets: z.array(channelConfigSchema).min(1).max(4),
  processingNode: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    mode: z.enum(['embedded', 'remote']),
    endpoint: z.string().url(),
    identityFingerprint: z.string().min(16),
  }),
  archivePolicy: z.object({
    retentionDays: z.number().int().min(1).max(3650),
    retainIndefinitely: z.boolean(),
    recordSource: z.boolean(),
    recordTranslations: z.boolean(),
  }),
  expectedDurationMinutes: z.number().positive().max(480).default(120),
  budgetWarningUsd: z.number().positive().default(20),
});

export const transcriptInputSchema = z.object({
  text: z.string().min(1).max(10_000),
  sourceStartMs: z.number().int().nonnegative(),
  sourceEndMs: z.number().int().positive(),
  final: z.boolean().default(true),
  sequence: z.number().int().nonnegative(),
  timing: z
    .object({
      captureCompletedAtUnixMs: z.number().int().nonnegative().optional(),
      chunkReadyAtUnixMs: z.number().int().nonnegative().optional(),
      transcriptionEngine: z.string().min(1).optional(),
      transcription: z
        .object({
          startedAtUnixMs: z.number().int().nonnegative(),
          firstDeltaAtUnixMs: z.number().int().nonnegative().optional(),
          completedAtUnixMs: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .optional(),
});

export const pairingRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  clientName: z.string().min(1).max(100),
  clientPublicKey: z.string().min(32),
});
