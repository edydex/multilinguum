export const languages = ['en', 'ru', 'es', 'uk'] as const;
export type Language = (typeof languages)[number];

export type SessionState = 'preflight' | 'starting' | 'live' | 'stopping' | 'completed' | 'failed';

export type VoiceMode = 'source' | 'natural' | 'cloned';
export type ProviderKind = 'openai-realtime' | 'openai-cascade' | 'local' | 'deterministic';

export interface ProcessingNodeRef {
  id: string;
  name: string;
  mode: 'embedded' | 'remote';
  endpoint: string;
  identityFingerprint: string;
}

export interface ArchivePolicy {
  retentionDays: number;
  retainIndefinitely: boolean;
  recordSource: boolean;
  recordTranslations: boolean;
}

export interface ChannelConfig {
  id: string;
  targetLanguage: Language;
  translationProvider: ProviderKind;
  voiceMode: VoiceMode;
  voiceProfileId?: string;
  fallbackOrder: Array<'natural' | 'cloned' | 'mute'>;
  muted: boolean;
}

export interface ServiceSession {
  id: string;
  state: SessionState;
  sourceLanguage: 'en' | 'ru';
  targets: ChannelConfig[];
  processingNode: ProcessingNodeRef;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  relayRoom?: string;
  archivePolicy: ArchivePolicy;
  configurationLocked: boolean;
  budgetWarningUsd: number;
  estimatedCostUsd: number;
}

export interface ConsentRecord {
  id: string;
  speakerName: string;
  confirmedAt: string;
  authorizerName: string;
  permittedUse: string;
  permittedLanguages: Language[];
  expiresAt?: string;
  revokedAt?: string;
  evidenceReference: string;
}

export interface VoiceProfile {
  id: string;
  displayName: string;
  /** Language spoken in the reference recording used to condition the clone. */
  referenceLanguage?: Language;
  encryptedSampleLocation: string;
  sampleSha256: string;
  supportedLanguages: Language[];
  consent: ConsentRecord;
  status: 'pending' | 'ready' | 'disabled' | 'revoked';
  createdAt: string;
  revokedAt?: string;
}

export interface ChannelHealth {
  channelId: string;
  targetLanguage: Language;
  listenerCount: number;
  lastTranscriptAt?: string;
  lastAudioAt?: string;
  latencyMs: number;
  backlogMs: number;
  engine: string;
  state: 'idle' | 'starting' | 'healthy' | 'degraded' | 'failed' | 'muted';
  latency?: ChannelLatencySummary;
  error?: string;
}

export interface LatencySpan {
  startedAtUnixMs: number;
  firstDeltaAtUnixMs?: number | undefined;
  completedAtUnixMs: number;
}

export interface SourceProcessingTiming {
  captureCompletedAtUnixMs?: number | undefined;
  chunkReadyAtUnixMs?: number | undefined;
  transcriptionEngine?: string | undefined;
  transcription?: LatencySpan | undefined;
}

export interface PipelineLatencyBreakdown {
  chunkWindowMs: number;
  chunkReadyDelayMs?: number;
  captureToTranscriptionStartMs?: number;
  transcriptionFirstDeltaMs?: number;
  transcriptionMs?: number;
  translationFirstDeltaMs?: number;
  translationMs?: number;
  speechRenderMs?: number;
  captionPublishMs?: number;
  audioPublishMs?: number;
  sourceEndToTranscriptMs?: number;
  sourceEndToCaptionMs?: number;
  sourceEndToAudioMs?: number;
  sourceStartToAudioMs?: number;
}

export interface PipelineLatencySample {
  id: string;
  sessionId: string;
  channelId: string;
  language: Language;
  sequence: number;
  sourceStartMs: number;
  sourceEndMs: number;
  recordedAt: string;
  captureCompletedAtUnixMs?: number;
  chunkReadyAtUnixMs?: number;
  transcription?: LatencySpan;
  translation?: LatencySpan;
  speechRender?: LatencySpan;
  captionPublish?: LatencySpan;
  audioPublish?: LatencySpan;
  metrics: PipelineLatencyBreakdown;
  engines: {
    transcription?: string;
    translation?: string;
    speechRenderer?: string;
    relay: string;
  };
  outcome: 'complete' | 'failed';
  error?: string;
}

export interface ChannelLatencySummary {
  sampleCount: number;
  latest: PipelineLatencyBreakdown;
  p50: PipelineLatencyBreakdown;
  p95: PipelineLatencyBreakdown;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  channelId: string;
  language: Language;
  text: string;
  sourceStartMs: number;
  sourceEndMs: number;
  emittedAt: string;
  firstDeltaAtUnixMs?: number;
  final: boolean;
  sequence: number;
}

export interface AudioTrackManifest {
  channelId: string;
  language: Language;
  path: string;
  codec: 'opus';
  sampleRate: 48000;
  sha256?: string;
}

export interface TranscriptManifest {
  channelId: string;
  language: Language;
  path: string;
  sha256?: string;
}

export interface ArchiveManifest {
  version: 1;
  sessionId: string;
  createdAt: string;
  completedAt?: string;
  sourceLanguage: Language;
  engineVersions: Record<string, string>;
  audioTracks: AudioTrackManifest[];
  transcripts: TranscriptManifest[];
  latencyReport: {
    path: 'latency.jsonl';
    sampleCount: number;
    channels: Record<string, ChannelLatencySummary>;
    sha256?: string;
  };
  retentionDeadline: string;
  retained: boolean;
  integritySha256?: string;
}

export interface TimestampedAudioFrame {
  sessionId: string;
  sequence: number;
  capturedAtUnixMs: number;
  sampleRate: 48000;
  channels: 1;
  encoding: 'pcm_s16le';
  samples: Uint8Array;
}

export type ProcessorEvent =
  | { type: 'session'; session: ServiceSession }
  | { type: 'health'; health: ChannelHealth }
  | { type: 'transcript'; segment: TranscriptSegment }
  | { type: 'latency'; sample: PipelineLatencySample }
  | { type: 'cost'; estimatedCostUsd: number; budgetWarning: boolean }
  | { type: 'error'; scope: string; message: string };

export interface PublicServiceState {
  active: boolean;
  sessionId?: string;
  churchName: string;
  startedAt?: string;
  languages: Array<{
    language: Language;
    voiceMode: VoiceMode;
    available: boolean;
    disclosure: string;
  }>;
}

export interface PairingOffer {
  nodeId: string;
  displayName: string;
  endpoint: string;
  identityFingerprint: string;
  expiresAt: string;
}

export interface PairingRequest {
  code: string;
  clientName: string;
  clientPublicKey: string;
}

export interface PairingResult {
  node: ProcessingNodeRef;
  clientCertificate: string;
  certificateExpiresAt: string;
}
