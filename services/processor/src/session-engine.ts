import { randomUUID } from 'node:crypto';
import type {
  ArchiveManifest,
  ArchiveStore,
  ChannelConfig,
  ChannelHealth,
  MediaRelay,
  LatencySpan,
  PipelineLatencySample,
  ProcessorEvent,
  ServiceSession,
  SpeechRenderer,
  SourceProcessingTiming,
  TranscriptSegment,
  TranslationProvider,
  VoiceProfile,
} from '@multilinguum/protocol';
import { createSessionSchema, estimateCloudServiceCost } from '@multilinguum/protocol';
import { defaultGlossary } from './glossary.js';
import { buildLatencyBreakdown, summarizeLatency } from './latency.js';
import type { VoiceProfileStore } from './voice-profile-store.js';

export interface SessionEngineDependencies {
  archive: ArchiveStore;
  relay: MediaRelay;
  profiles: VoiceProfileStore;
  deterministicTranslation: TranslationProvider;
  cloudTranslation?: TranslationProvider;
  deterministicSpeech: SpeechRenderer;
  naturalSpeech?: SpeechRenderer;
  clonedSpeech?: SpeechRenderer;
  broadcast: (event: ProcessorEvent) => void;
}

interface RuntimeChannel {
  config: ChannelConfig;
  health: ChannelHealth;
  effectiveVoiceMode: 'source' | 'natural' | 'cloned';
  precedingText: string[];
  latencySamples: PipelineLatencySample[];
}

export class SessionEngine {
  readonly #dependencies: SessionEngineDependencies;
  #session?: ServiceSession;
  readonly #channels = new Map<string, RuntimeChannel>();
  readonly #sourceAudioSpans = new Map<number, LatencySpan>();

  constructor(dependencies: SessionEngineDependencies) {
    this.#dependencies = dependencies;
  }

  current(): ServiceSession | undefined {
    return this.#session;
  }

  health(): ChannelHealth[] {
    return [...this.#channels.values()].map((channel) => channel.health);
  }

  async create(input: unknown): Promise<ServiceSession> {
    if (this.#session && !['completed', 'failed'].includes(this.#session.state)) {
      throw new Error('Only one church service can be active at a time.');
    }
    const parsed = createSessionSchema.parse(input);
    const targets: ChannelConfig[] = parsed.targets.map((target) => ({
      id: target.id,
      targetLanguage: target.targetLanguage,
      translationProvider: target.translationProvider,
      voiceMode: target.voiceMode,
      fallbackOrder: target.fallbackOrder,
      muted: target.muted,
      ...(target.voiceProfileId ? { voiceProfileId: target.voiceProfileId } : {}),
    }));
    const targetLanguages = targets.map((target) => target.targetLanguage);
    if (new Set(targetLanguages).size !== targetLanguages.length) {
      throw new Error('Each target language may appear only once.');
    }
    for (const channel of targets) {
      if (channel.voiceMode === 'source' && channel.targetLanguage !== parsed.sourceLanguage) {
        throw new Error('The source channel language must match the selected source language.');
      }
      if (
        channel.voiceMode === 'cloned' &&
        (parsed.sourceLanguage !== 'ru' || channel.targetLanguage !== 'en')
      ) {
        throw new Error('The first cloned-voice profile is restricted to RU to EN.');
      }
      if (channel.voiceMode === 'cloned') {
        await this.#validateVoiceProfile(channel);
      }
    }

    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const session: ServiceSession = {
      id,
      state: 'preflight',
      sourceLanguage: parsed.sourceLanguage,
      targets,
      processingNode: parsed.processingNode,
      createdAt,
      relayRoom: `service-${id}`,
      archivePolicy: parsed.archivePolicy,
      configurationLocked: false,
      budgetWarningUsd: parsed.budgetWarningUsd,
      estimatedCostUsd: estimateCloudServiceCost(parsed.expectedDurationMinutes, targets),
    };
    this.#session = session;
    this.#channels.clear();
    this.#sourceAudioSpans.clear();
    for (const config of targets) {
      this.#channels.set(config.id, {
        config,
        effectiveVoiceMode: config.voiceMode,
        precedingText: [],
        latencySamples: [],
        health: {
          channelId: config.id,
          targetLanguage: config.targetLanguage,
          listenerCount: 0,
          latencyMs: 0,
          backlogMs: 0,
          engine: config.translationProvider,
          state: 'idle',
        },
      });
    }
    this.#emitSession();
    this.#dependencies.broadcast({
      type: 'cost',
      estimatedCostUsd: session.estimatedCostUsd,
      budgetWarning: session.estimatedCostUsd >= session.budgetWarningUsd,
    });
    return session;
  }

  async start(): Promise<ServiceSession> {
    const session = this.#requiredSession();
    if (session.state !== 'preflight') throw new Error('Session is not ready to start.');
    const startingSession: ServiceSession = {
      ...session,
      state: 'starting',
      configurationLocked: true,
      startedAt: new Date().toISOString(),
    };
    this.#session = startingSession;
    this.#emitSession();
    await this.#dependencies.archive.create(startingSession, {
      processor: '0.1.0',
      translation: this.#translationProvider().name,
      naturalSpeech: this.#naturalRenderer().name,
      clonedSpeech: this.#dependencies.clonedSpeech?.name ?? 'not-configured',
    });
    await this.#dependencies.relay.createSession(startingSession);
    for (const channel of this.#channels.values()) {
      channel.health = { ...channel.health, state: 'starting' };
      this.#emitHealth(channel);
      await this.#dependencies.relay.publishChannel(channel.config);
      channel.health = {
        ...channel.health,
        state: channel.config.muted ? 'muted' : 'healthy',
      };
      this.#emitHealth(channel);
    }
    const liveSession: ServiceSession = { ...startingSession, state: 'live' };
    this.#session = liveSession;
    this.#emitSession();
    return liveSession;
  }

  async ingestTranscript(input: {
    text: string;
    sourceStartMs: number;
    sourceEndMs: number;
    final: boolean;
    sequence: number;
    timing?: SourceProcessingTiming | undefined;
  }): Promise<TranscriptSegment[]> {
    const session = this.#requiredSession();
    if (session.state !== 'live') throw new Error('Session is not live.');
    const source: TranscriptSegment = {
      id: randomUUID(),
      sessionId: session.id,
      channelId: `source-${session.sourceLanguage}`,
      language: session.sourceLanguage,
      text: input.text,
      sourceStartMs: input.sourceStartMs,
      sourceEndMs: input.sourceEndMs,
      emittedAt: new Date().toISOString(),
      final: input.final,
      sequence: input.sequence,
    };
    const sourceAudioSpan = this.#sourceAudioSpans.get(input.sequence);
    const results = await Promise.all(
      [...this.#channels.values()].map((channel) =>
        this.#processChannel(source, channel, input.timing, sourceAudioSpan),
      ),
    );
    this.#sourceAudioSpans.delete(input.sequence);
    return results.filter((segment): segment is TranscriptSegment => Boolean(segment));
  }

  async ingestSourceAudio(input: {
    data: Uint8Array;
    startMs: number;
    endMs: number;
    sequence: number;
    language: 'en' | 'ru';
    timing?: SourceProcessingTiming | undefined;
  }): Promise<void> {
    const session = this.#requiredSession();
    if (session.state !== 'live') throw new Error('Session is not live.');
    const sourceChannel = [...this.#channels.values()].find(
      (channel) => channel.config.voiceMode === 'source',
    );
    if (!sourceChannel) throw new Error('Session has no delayed source-audio channel.');
    const audio = {
      data: input.data,
      encoding: 'pcm_s16le' as const,
      sampleRate: 48000,
      startMs: input.startMs,
      endMs: input.endMs,
      sequence: input.sequence,
      language: input.language,
      renderer: 'delayed-original',
    };
    await this.#dependencies.archive.appendAudio(sourceChannel.config.id, audio);
    const publishStartedAtUnixMs = Date.now();
    await this.#dependencies.relay.publishAudio(sourceChannel.config.id, audio);
    const publishCompletedAtUnixMs = Date.now();
    this.#sourceAudioSpans.set(input.sequence, {
      startedAtUnixMs: publishStartedAtUnixMs,
      completedAtUnixMs: publishCompletedAtUnixMs,
    });
    const now = new Date().toISOString();
    sourceChannel.health = {
      ...sourceChannel.health,
      state: 'healthy',
      lastAudioAt: now,
      backlogMs: Math.max(
        0,
        Date.now() - (Date.parse(session.startedAt ?? session.createdAt) + input.endMs),
      ),
    };
    this.#emitHealth(sourceChannel);
  }

  async setMuted(channelId: string, muted: boolean): Promise<ChannelHealth> {
    const channel = this.#requiredChannel(channelId);
    channel.config = { ...channel.config, muted };
    channel.health = { ...channel.health, state: muted ? 'muted' : 'healthy' };
    this.#emitHealth(channel);
    return channel.health;
  }

  async forceNatural(channelId: string): Promise<ChannelHealth> {
    const channel = this.#requiredChannel(channelId);
    channel.effectiveVoiceMode = 'natural';
    const nextHealth: ChannelHealth = {
      ...channel.health,
      engine: `${channel.config.translationProvider}+${this.#naturalRenderer().name}`,
      state: 'healthy',
    };
    delete nextHealth.error;
    channel.health = nextHealth;
    this.#emitHealth(channel);
    return channel.health;
  }

  async restartChannel(channelId: string): Promise<ChannelHealth> {
    const channel = this.#requiredChannel(channelId);
    const nextHealth: ChannelHealth = { ...channel.health, state: 'starting', backlogMs: 0 };
    delete nextHealth.error;
    channel.health = nextHealth;
    this.#emitHealth(channel);
    await this.#dependencies.relay.publishChannel(channel.config);
    channel.health = { ...channel.health, state: channel.config.muted ? 'muted' : 'healthy' };
    this.#emitHealth(channel);
    return channel.health;
  }

  async stop(): Promise<{ session: ServiceSession; archive: ArchiveManifest }> {
    const session = this.#requiredSession();
    if (!['live', 'failed'].includes(session.state)) throw new Error('Session is not active.');
    this.#session = { ...session, state: 'stopping' };
    this.#emitSession();
    await this.#dependencies.relay.closeSession(session.id);
    const archive = await this.#dependencies.archive.finalize(session.id);
    this.#session = {
      ...this.#session,
      state: 'completed',
      stoppedAt: archive.completedAt ?? new Date().toISOString(),
    };
    this.#emitSession();
    return { session: this.#session, archive };
  }

  async #processChannel(
    source: TranscriptSegment,
    runtime: RuntimeChannel,
    sourceTiming?: SourceProcessingTiming,
    sourceAudioSpan?: LatencySpan,
  ): Promise<TranscriptSegment | undefined> {
    if (runtime.config.muted) return undefined;
    const session = this.#requiredSession();
    let translation: LatencySpan | undefined;
    let speechRender: LatencySpan | undefined;
    let captionPublish: LatencySpan | undefined;
    let audioPublish: LatencySpan | undefined;
    let speechRenderer: string | undefined;
    try {
      let translated: TranscriptSegment;
      if (runtime.config.voiceMode === 'source') {
        translated = { ...source, channelId: runtime.config.id };
        audioPublish = sourceAudioSpan;
      } else {
        const translationStartedAtUnixMs = Date.now();
        try {
          translated = await this.#translationProvider(runtime.config).translate(source, {
            sourceLanguage: session.sourceLanguage,
            targetLanguage: runtime.config.targetLanguage,
            glossary: defaultGlossary[runtime.config.targetLanguage],
            precedingText: runtime.precedingText,
          });
        } finally {
          translation = {
            startedAtUnixMs: translationStartedAtUnixMs,
            completedAtUnixMs: Date.now(),
          };
        }
        translated = { ...translated, channelId: runtime.config.id, sessionId: session.id };
      }
      runtime.precedingText.push(translated.text);
      runtime.precedingText = runtime.precedingText.slice(-8);
      const expectedAt = Date.parse(session.startedAt ?? session.createdAt) + source.sourceEndMs;
      const backlogMs = Math.max(0, Date.now() - expectedAt);
      if (runtime.effectiveVoiceMode === 'cloned' && backlogMs > 10_000) {
        runtime.effectiveVoiceMode = 'natural';
        this.#dependencies.broadcast({
          type: 'error',
          scope: runtime.config.id,
          message: 'Cloned output exceeded ten seconds of backlog; switched to natural voice.',
        });
      }
      await this.#dependencies.archive.appendTranscript(translated);
      const captionStartedAtUnixMs = Date.now();
      await this.#dependencies.relay.publishCaption(translated);
      captionPublish = {
        startedAtUnixMs: captionStartedAtUnixMs,
        completedAtUnixMs: Date.now(),
      };
      if (runtime.effectiveVoiceMode !== 'source') {
        const renderStartedAtUnixMs = Date.now();
        let rendered;
        try {
          rendered = await this.#render(runtime, translated);
        } finally {
          speechRender = {
            startedAtUnixMs: renderStartedAtUnixMs,
            completedAtUnixMs: Date.now(),
          };
        }
        speechRenderer = rendered.renderer;
        await this.#dependencies.archive.appendAudio(runtime.config.id, rendered);
        const audioStartedAtUnixMs = Date.now();
        await this.#dependencies.relay.publishAudio(runtime.config.id, rendered);
        audioPublish = {
          startedAtUnixMs: audioStartedAtUnixMs,
          completedAtUnixMs: Date.now(),
        };
      }
      const sample = this.#latencySample({
        runtime,
        source,
        sourceTiming,
        translation,
        speechRender,
        captionPublish,
        audioPublish,
        speechRenderer,
        outcome: 'complete',
      });
      await this.#recordLatency(runtime, sample);
      const now = new Date().toISOString();
      const measuredLatency =
        sample.metrics.sourceEndToAudioMs ?? sample.metrics.sourceEndToCaptionMs ?? backlogMs;
      const nextHealth: ChannelHealth = {
        ...runtime.health,
        state: 'healthy',
        lastTranscriptAt: now,
        ...(runtime.effectiveVoiceMode === 'source' ? {} : { lastAudioAt: now }),
        latencyMs: Math.max(0, measuredLatency),
        backlogMs,
        engine: `${this.#translationProvider(runtime.config).name}+${runtime.effectiveVoiceMode}`,
        latency: summarizeLatency(runtime.latencySamples),
      };
      delete nextHealth.error;
      runtime.health = nextHealth;
      this.#emitHealth(runtime);
      return translated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sample = this.#latencySample({
        runtime,
        source,
        sourceTiming,
        translation,
        speechRender,
        captionPublish,
        audioPublish,
        speechRenderer,
        outcome: 'failed',
        error: message,
      });
      await this.#recordLatency(runtime, sample).catch(() => undefined);
      const failedLatency =
        sample.metrics.sourceEndToAudioMs ??
        sample.metrics.sourceEndToCaptionMs ??
        runtime.health.latencyMs;
      const failureHealth = {
        ...runtime.health,
        latencyMs: Math.max(0, failedLatency),
        ...(runtime.latencySamples.length > 0
          ? { latency: summarizeLatency(runtime.latencySamples) }
          : {}),
        error: message,
      };
      if (
        runtime.effectiveVoiceMode === 'cloned' &&
        runtime.config.fallbackOrder.includes('natural')
      ) {
        runtime.effectiveVoiceMode = 'natural';
        runtime.health = { ...failureHealth, state: 'degraded' };
      } else {
        runtime.health = { ...failureHealth, state: 'failed' };
      }
      this.#emitHealth(runtime);
      this.#dependencies.broadcast({ type: 'error', scope: runtime.config.id, message });
      return undefined;
    }
  }

  async #render(runtime: RuntimeChannel, segment: TranscriptSegment) {
    if (runtime.effectiveVoiceMode === 'cloned') {
      if (!this.#dependencies.clonedSpeech) throw new Error('Cloned renderer is not configured.');
      const profile = await this.#voiceProfile(runtime.config);
      return this.#dependencies.clonedSpeech.render(segment, profile);
    }
    return this.#naturalRenderer().render(segment);
  }

  #latencySample(input: {
    runtime: RuntimeChannel;
    source: TranscriptSegment;
    sourceTiming?: SourceProcessingTiming | undefined;
    translation?: LatencySpan | undefined;
    speechRender?: LatencySpan | undefined;
    captionPublish?: LatencySpan | undefined;
    audioPublish?: LatencySpan | undefined;
    speechRenderer?: string | undefined;
    outcome: 'complete' | 'failed';
    error?: string | undefined;
  }): PipelineLatencySample {
    const base = {
      id: randomUUID(),
      sessionId: input.source.sessionId,
      channelId: input.runtime.config.id,
      language: input.runtime.config.targetLanguage,
      sequence: input.source.sequence,
      sourceStartMs: input.source.sourceStartMs,
      sourceEndMs: input.source.sourceEndMs,
      recordedAt: new Date().toISOString(),
      ...(input.sourceTiming?.captureCompletedAtUnixMs !== undefined
        ? { captureCompletedAtUnixMs: input.sourceTiming.captureCompletedAtUnixMs }
        : {}),
      ...(input.sourceTiming?.chunkReadyAtUnixMs !== undefined
        ? { chunkReadyAtUnixMs: input.sourceTiming.chunkReadyAtUnixMs }
        : {}),
      ...(input.sourceTiming?.transcription
        ? { transcription: input.sourceTiming.transcription }
        : {}),
      ...(input.translation ? { translation: input.translation } : {}),
      ...(input.speechRender ? { speechRender: input.speechRender } : {}),
      ...(input.captionPublish ? { captionPublish: input.captionPublish } : {}),
      ...(input.audioPublish ? { audioPublish: input.audioPublish } : {}),
      engines: {
        ...(input.sourceTiming?.transcription
          ? { transcription: input.sourceTiming.transcriptionEngine ?? 'capture-transcriber' }
          : {}),
        ...(input.runtime.config.voiceMode !== 'source'
          ? { translation: this.#translationProvider(input.runtime.config).name }
          : {}),
        ...(input.speechRenderer ? { speechRenderer: input.speechRenderer } : {}),
        relay: this.#dependencies.relay.name,
      },
      outcome: input.outcome,
      ...(input.error ? { error: input.error } : {}),
    } satisfies Omit<PipelineLatencySample, 'metrics'>;
    return { ...base, metrics: buildLatencyBreakdown(base) };
  }

  async #recordLatency(runtime: RuntimeChannel, sample: PipelineLatencySample): Promise<void> {
    await this.#dependencies.archive.appendLatency(sample);
    runtime.latencySamples.push(sample);
    runtime.latencySamples = runtime.latencySamples.slice(-10_000);
    this.#dependencies.broadcast({ type: 'latency', sample });
  }

  #translationProvider(config?: ChannelConfig): TranslationProvider {
    if (config?.translationProvider === 'deterministic') {
      return this.#dependencies.deterministicTranslation;
    }
    return this.#dependencies.cloudTranslation ?? this.#dependencies.deterministicTranslation;
  }

  #naturalRenderer(): SpeechRenderer {
    return this.#dependencies.naturalSpeech ?? this.#dependencies.deterministicSpeech;
  }

  async #voiceProfile(config: ChannelConfig): Promise<VoiceProfile> {
    if (!config.voiceProfileId) throw new Error('Cloned channel has no voice profile.');
    const profile = await this.#dependencies.profiles.get(config.voiceProfileId);
    if (!profile || profile.status !== 'ready' || profile.consent.revokedAt) {
      throw new Error('Voice profile is unavailable or consent has been revoked.');
    }
    return profile;
  }

  async #validateVoiceProfile(config: ChannelConfig): Promise<void> {
    const profile = await this.#voiceProfile(config);
    if (!profile.supportedLanguages.includes(config.targetLanguage)) {
      throw new Error(`Voice profile does not support ${config.targetLanguage}.`);
    }
    if (!profile.consent.permittedLanguages.includes(config.targetLanguage)) {
      throw new Error(`Voice consent does not permit ${config.targetLanguage}.`);
    }
    if (profile.consent.expiresAt && Date.parse(profile.consent.expiresAt) <= Date.now()) {
      throw new Error('Voice consent has expired.');
    }
  }

  #requiredSession(): ServiceSession {
    if (!this.#session) throw new Error('No service session exists.');
    return this.#session;
  }

  #requiredChannel(channelId: string): RuntimeChannel {
    const channel = this.#channels.get(channelId);
    if (!channel) throw new Error('Channel not found.');
    return channel;
  }

  #emitSession(): void {
    this.#dependencies.broadcast({ type: 'session', session: this.#requiredSession() });
  }

  #emitHealth(channel: RuntimeChannel): void {
    this.#dependencies.broadcast({ type: 'health', health: channel.health });
  }
}
