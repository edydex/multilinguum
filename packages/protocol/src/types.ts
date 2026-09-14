import type { ServiceUsage } from './usage.js';

export const languages = ['en', 'ru', 'es', 'uk'] as const;
export type Language = (typeof languages)[number];

export type SessionState = 'preflight' | 'starting' | 'live' | 'stopping' | 'completed' | 'failed';

export type VoiceMode = 'source' | 'natural' | 'cloned';
export type ProviderKind = 'openai-realtime' | 'openai-cascade' | 'local' | 'deterministic';

export type TranslationProfileId = 'quality' | 'economy';

/** Safe operator-facing configuration. Never include credentials or project identifiers. */
export interface TranslationProfileInfo {
  id: TranslationProfileId;
  label: string;
  ready: boolean;
  unavailableReason?: string;
  textModel: string;
  reasoningEffort: 'none' | 'low';
  transcriptionModel: string;
  speechModel: string;
  sharing: 'not-requested' | 'administrator-confirmed-text-project';
  allowanceVerified: false;
  overagePolicy: 'block' | 'allow-billed';
  qualityValidated: false;
  rates: {
    checkedOn: string;
    textInputPerMillionUsd: number | null;
    textOutputPerMillionUsd: number | null;
    transcriptionPerMinuteUsd: number | null;
  };
}

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
  /** False disables audio generation/publication while translation continues. Omitted by older clients. */
  speechEnabled?: boolean;
}

export interface ContextDocument {
  id: string;
  filename: string;
  contentType: 'application/pdf' | 'text/plain';
  sha256: string;
  uploadedAt: string;
  characterCount: number;
}

/** Operator-declared link to the reviewed Community service, retained privately with the session. */
export interface ServiceReference {
  communityId: string;
  serviceId: string;
  title: string;
  serviceDate: string;
  serviceRevision: string;
  planRevision: number;
}

export interface ServiceSession {
  serviceReference?: ServiceReference;
  id: string;
  state: SessionState;
  sourceLanguage: 'en' | 'ru';
  targets: ChannelConfig[];
  processingNode: ProcessingNodeRef;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  relayRoom?: string;
  contextDocumentIds: string[];
  /** Explicit permission for this session's selected notes to enter the Economy sharing project. */
  shareSermonNotesWithEconomy?: boolean;
  archivePolicy: ArchivePolicy;
  configurationLocked: boolean;
  budgetWarningUsd: number;
  estimatedCostUsd: number;
  usage?: ServiceUsage;
  translationProfile?: TranslationProfileInfo;
  /** Older profiles expose a recognition-only forecast; new ones expose an explicitly partial live subtotal. */
  costEstimateKind?: 'transcription-only' | 'observed-partial';
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
  playoutQueueMs?: number;
  sourceEndToTranscriptMs?: number;
  sourceEndToCaptionMs?: number;
  sourceEndToAudioMs?: number;
  sourceStartToAudioMs?: number;
  sourceEndToPlayoutMs?: number;
  sourceStartToPlayoutMs?: number;
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
  playout?: LatencySpan;
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
  /** Monotonic update number for provisional revisions of the same sequence. */
  revision?: number;
  /** Why this caption is provisional, or that finalized speech is queued. */
  phase?: 'transcribing' | 'translating' | 'queued';
  /** A source-audio pause detected immediately after this segment. */
  sourcePauseAfterMs?: number | undefined;
  /** Coarse source delivery cues used to steer generic speech without copying a voice. */
  sourceDelivery?: SourceDelivery | undefined;
  /** Semantic delivery decisions produced with the translation for narrator phrasing. */
  narrationPlan?: NarrationPlan | undefined;
  /** Capture-clock source bounds; microphone capture may start after the session. */
  sourceStartAtUnixMs?: number;
  sourceEndAtUnixMs?: number;
  /** Server-clock schedule for the audio listeners actually hear. */
  playout?: CaptionPlayoutTiming;
  final: boolean;
  sequence: number;
}

export interface SourceDelivery {
  /** Broad source-language performance evidence, not a target-language prosody prescription. */
  pace: 'measured' | 'steady' | 'animated';
  energy: 'soft' | 'balanced' | 'emphatic';
  contour: 'statement' | 'question' | 'continuation' | 'exclamation';
}

export interface NarrationBeat {
  /** Exact translated-text span that anchors this part of the English delivery arc. */
  text: string;
  function: 'setup' | 'parallel' | 'contrast' | 'climax' | 'resolution';
  strength: 'restrained' | 'normal' | 'building' | 'strong';
}

export interface NarrationPlan {
  role:
    | 'neutral'
    | 'question'
    | 'enumeration'
    | 'contrast'
    | 'appeal'
    | 'exhortation'
    | 'warning'
    | 'correction'
    | 'quotation'
    | 'transition';
  cadence: 'flowing' | 'measured' | 'separated' | 'urgent';
  /** Position of this segment in the target-language rhetorical thought. */
  arc: 'standalone' | 'setup' | 'build' | 'climax' | 'resolution';
  pauseBefore: 'none' | 'brief';
  pauseAfter: 'connected' | 'brief' | 'full';
  /** Exact substrings in translated text that carry the thought's primary stress. */
  emphasis: string[];
  /** Ordered, target-language-native performance anchors. */
  beats: NarrationBeat[];
}

export interface CaptionWordTiming {
  text: string;
  startOffsetMs: number;
  endOffsetMs: number;
}

export interface CaptionPlayoutTiming {
  startAtUnixMs: number;
  endAtUnixMs: number;
  words: CaptionWordTiming[];
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
  serviceReference?: ServiceReference;
  usage?: ServiceUsage;
  translationProfile?: TranslationProfileInfo;
  sermonNotes?: { documentIds: string[]; sharedWithEconomy: boolean };
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
  | {
      type: 'cost';
      estimatedCostUsd: number;
      budgetWarning: boolean;
      sessionId?: string;
      usage?: ServiceUsage;
    }
  | { type: 'error'; scope: string; message: string };

/** Public metadata only. PCM and private session configuration never enter events. */
export interface BufferedAudioClip {
  id: string;
  sessionId: string;
  channelId: string;
  language: Language;
  generation: number;
  sequence: number;
  sourceStartAtUnixMs: number;
  sourceEndAtUnixMs: number;
  publishedAtUnixMs: number;
  durationMs: number;
  byteLength: number;
}

export type PublicAudioEvent =
  | { type: 'audio-clip'; clip: BufferedAudioClip }
  | { type: 'audio-clear'; sessionId: string; channelId: string; generation: number };

export interface PublicServiceState {
  active: boolean;
  serverTimeUnixMs: number;
  sessionId?: string;
  churchName: string;
  startedAt?: string;
  languages: Array<{
    language: Language;
    voiceMode: VoiceMode;
    available: boolean;
    /** Separately reported so captions remain available without an audio relay. */
    audioAvailable?: boolean;
    /** Source-timestamped WAV window, independent of LiveKit credentials. */
    bufferedAudioAvailable?: boolean;
    channelId?: string;
    audioGeneration?: number;
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
