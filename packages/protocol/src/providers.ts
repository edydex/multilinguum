import type {
  ArchiveManifest,
  ChannelConfig,
  Language,
  PipelineLatencySample,
  ServiceSession,
  TranscriptSegment,
  VoiceProfile,
} from './types.js';

export interface AudioChunk {
  data: Uint8Array;
  encoding: 'pcm_s16le' | 'opus';
  sampleRate: number;
  startMs: number;
  endMs: number;
  sequence: number;
}

export interface RenderedSpeech extends AudioChunk {
  language: Language;
  renderer: string;
}

export interface TranslationContext {
  sourceLanguage: Language;
  targetLanguage: Language;
  glossary: Readonly<Record<string, string>>;
  precedingText: string[];
}

export interface Transcriber {
  readonly name: string;
  start(session: ServiceSession): Promise<void>;
  pushAudio(chunk: AudioChunk): Promise<void>;
  stop(): Promise<void>;
  onSegment(listener: (segment: TranscriptSegment) => void): () => void;
}

export interface TranslationProvider {
  readonly name: string;
  translate(segment: TranscriptSegment, context: TranslationContext): Promise<TranscriptSegment>;
}

export interface SpeechRenderer {
  readonly name: string;
  render(segment: TranscriptSegment, profile?: VoiceProfile): Promise<RenderedSpeech>;
  health(): Promise<{ ready: boolean; detail?: string }>;
}

export interface PublishedChannel {
  channelId: string;
  roomName: string;
  trackName: string;
}

export interface MediaRelay {
  readonly name: string;
  createSession(session: ServiceSession): Promise<void>;
  publishChannel(config: ChannelConfig): Promise<PublishedChannel>;
  publishAudio(channelId: string, chunk: RenderedSpeech): Promise<void>;
  publishCaption(segment: TranscriptSegment): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

export interface ArchiveStore {
  create(session: ServiceSession, engineVersions: Record<string, string>): Promise<ArchiveManifest>;
  appendTranscript(segment: TranscriptSegment): Promise<void>;
  appendAudio(channelId: string, chunk: RenderedSpeech): Promise<void>;
  appendLatency(sample: PipelineLatencySample): Promise<void>;
  finalize(sessionId: string): Promise<ArchiveManifest>;
  list(): Promise<ArchiveManifest[]>;
  retain(sessionId: string, retained: boolean): Promise<ArchiveManifest>;
  delete(sessionId: string): Promise<void>;
  purgeExpired(now?: Date): Promise<string[]>;
}
