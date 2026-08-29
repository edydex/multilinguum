import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  ArchiveManifest,
  ChannelConfig,
  ChannelHealth,
  Language,
  ProcessorEvent,
  ServiceSession,
  TranscriptSegment,
  VoiceProfile,
} from '@multilinguum/protocol';
import { api, subscribe, type OperatorConnection } from './api';
import { useAudioMeter } from './useAudioMeter';
import { useAudioStreamer } from './useAudioStreamer';
import { dbToMeterPercent, signalStatus } from './audioLevel';

const names: Record<Language, string> = {
  en: 'English',
  ru: 'Russian',
  es: 'Spanish',
  uk: 'Ukrainian',
};

const allLanguages: Language[] = ['en', 'ru', 'es', 'uk'];

interface TargetDraft {
  enabled: boolean;
  outputMode: OutputMode;
  profileId: string;
}

type OutputMode = 'source' | 'generic-fast' | 'generic-expressive' | 'cloned';

interface VoiceProfileDraft {
  voiceName: string;
  speakerName: string;
  authorizerName: string;
  confirmedDate: string;
  referenceLanguage: 'en' | 'ru';
  sample?: File;
  consentConfirmed: boolean;
}

function newVoiceProfileDraft(): VoiceProfileDraft {
  return {
    voiceName: '',
    speakerName: '',
    authorizerName: '',
    confirmedDate: new Date().toISOString().slice(0, 10),
    referenceLanguage: 'en',
    consentConfirmed: false,
  };
}

function initialTargets(source: 'en' | 'ru'): Record<Language, TargetDraft> {
  return Object.fromEntries(
    allLanguages.map((language) => [
      language,
      {
        enabled: true,
        outputMode: language === source ? 'source' : 'generic-expressive',
        profileId: '',
      },
    ]),
  ) as Record<Language, TargetDraft>;
}

function formatLatency(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

function archiveP95Latency(archive: ArchiveManifest): number | undefined {
  const values = Object.values(archive.latencyReport.channels)
    .map((summary) => summary.p95.sourceEndToAudioMs ?? summary.p95.sourceEndToCaptionMs)
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

export function App() {
  const [tab, setTab] = useState<'service' | 'archives' | 'connection'>('service');
  const [baseUrl, setBaseUrl] = useState(
    () => localStorage.getItem('processorUrl') ?? 'http://127.0.0.1:4310',
  );
  const [token, setToken] = useState(
    () => localStorage.getItem('processorToken') ?? 'development-control-token-change-me-now',
  );
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<ServiceSession>();
  const [health, setHealth] = useState<Record<string, ChannelHealth>>({});
  const [captions, setCaptions] = useState<Record<string, TranscriptSegment>>({});
  const [archives, setArchives] = useState<ArchiveManifest[]>([]);
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfile[]>([]);
  const [addingVoice, setAddingVoice] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState<VoiceProfileDraft>(newVoiceProfileDraft);
  const [preflight, setPreflight] = useState<Record<string, unknown>>();
  const [source, setSource] = useState<'en' | 'ru'>('ru');
  const [targets, setTargets] = useState(() => initialTargets('ru'));
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(
    () => localStorage.getItem('audioDeviceId') || undefined,
  );
  const [audioReady, setAudioReady] = useState(false);
  const [boothDeviceLabel, setBoothDeviceLabel] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [playbackUrl, setPlaybackUrl] = useState<string>();
  const audio = useAudioMeter(selectedDeviceId, audioReady);
  const {
    devices,
    levelDb,
    activeChannel,
    channelCount,
    sampleRate,
    subscribePcm,
    error: audioError,
  } = audio;

  const connection = useMemo<OperatorConnection>(() => ({ baseUrl, token }), [baseUrl, token]);
  const live = session?.state === 'live' || session?.state === 'starting';
  const configuredSource = live && session ? session.sourceLanguage : source;
  const displayedLanguages: Language[] =
    live && session ? session.targets.map((channel) => channel.targetLanguage) : allLanguages;
  const capture = useAudioStreamer(
    session?.state === 'live',
    session?.id,
    connection,
    subscribePcm,
  );

  useEffect(() => {
    void invoke<{
      processorUrl?: string;
      processorToken?: string;
      audioDeviceLabel?: string;
    }>('bootstrap_connection')
      .then((bootstrap) => {
        if (bootstrap.processorUrl) setBaseUrl(bootstrap.processorUrl);
        if (bootstrap.processorToken) setToken(bootstrap.processorToken);
        if (bootstrap.audioDeviceLabel) setBoothDeviceLabel(bootstrap.audioDeviceLabel);
        else setAudioReady(true);
      })
      .catch(() => {
        // The same React UI can run in a browser during development, where Tauri IPC is absent.
        setAudioReady(true);
      });
  }, []);

  useEffect(() => {
    if (!boothDeviceLabel) return;
    const configured = devices.find((device) => device.label === boothDeviceLabel);
    if (!configured) return;
    if (configured.id !== selectedDeviceId) setSelectedDeviceId(configured.id);
    setAudioReady(true);
    setBoothDeviceLabel(undefined);
  }, [boothDeviceLabel, devices, selectedDeviceId]);

  const refresh = useCallback(async () => {
    try {
      const [current, nextPreflight, nextArchives, nextVoiceProfiles] = await Promise.all([
        api.current(connection),
        api.preflight(connection),
        api.archives(connection),
        api.voiceProfiles(connection),
      ]);
      setSession(current.session);
      setHealth(Object.fromEntries(current.health.map((item) => [item.channelId, item])));
      setPreflight(nextPreflight);
      setArchives(nextArchives);
      setVoiceProfiles(nextVoiceProfiles);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [connection]);

  useEffect(() => {
    localStorage.setItem('processorUrl', baseUrl);
    localStorage.setItem('processorToken', token);
    void refresh();
    return subscribe(
      connection,
      (event: ProcessorEvent) => {
        if (event.type === 'session') setSession(event.session);
        if (event.type === 'health') {
          setHealth((current) => ({ ...current, [event.health.channelId]: event.health }));
        }
        if (event.type === 'transcript') {
          setCaptions((current) => ({ ...current, [event.segment.channelId]: event.segment }));
        }
        if (event.type === 'error') setError(`${event.scope}: ${event.message}`);
      },
      setConnected,
    );
  }, [baseUrl, connection, refresh, token]);

  useEffect(() => {
    if (selectedDeviceId) localStorage.setItem('audioDeviceId', selectedDeviceId);
    else localStorage.removeItem('audioDeviceId');
  }, [selectedDeviceId]);

  useEffect(
    () => () => {
      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
    },
    [playbackUrl],
  );

  const playArchive = async (sessionId: string, channelId: string) => {
    try {
      const blob = await api.archiveAudio(connection, sessionId, channelId);
      setPlaybackUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(blob);
      });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportTranscript = async (sessionId: string, channelId: string, language: Language) => {
    try {
      const blob = await api.archiveTranscript(connection, sessionId, channelId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${sessionId}-${language}.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportLatency = async (sessionId: string) => {
    try {
      const blob = await api.archiveLatency(connection, sessionId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${sessionId}-latency.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const changeSource = (nextSource: 'en' | 'ru') => {
    setSource(nextSource);
    setTargets((current) => {
      const next = structuredClone(current);
      for (const language of allLanguages) {
        const previous = next[language]!;
        if (language === nextSource) {
          next[language] = { ...previous, enabled: true, outputMode: 'source' };
        } else if (previous.outputMode === 'source') {
          next[language] = { ...previous, outputMode: 'generic-expressive' };
        }
      }
      return next;
    });
  };

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const channelConfigs: ChannelConfig[] = allLanguages
        .filter((language) => targets[language]!.enabled)
        .map((language) => {
          const draft = targets[language]!;
          return {
            id: `channel-${language}`,
            targetLanguage: language,
            translationProvider:
              language === source
                ? 'deterministic'
                : draft.outputMode === 'generic-fast'
                  ? 'openai-realtime'
                  : 'openai-cascade',
            voiceMode:
              language === source ? 'source' : draft.outputMode === 'cloned' ? 'cloned' : 'natural',
            ...(draft.outputMode === 'cloned' && draft.profileId
              ? { voiceProfileId: draft.profileId }
              : {}),
            fallbackOrder: language === source ? ['mute'] : ['natural', 'mute'],
            muted: false,
          };
        });
      await api.create(connection, {
        sourceLanguage: source,
        targets: channelConfigs,
        processingNode: {
          id: 'local-node',
          name: baseUrl.includes('127.0.0.1') ? 'This Mac' : 'Paired processor',
          mode: baseUrl.includes('127.0.0.1') ? 'embedded' : 'remote',
          endpoint: baseUrl,
          identityFingerprint: 'development-pending-pinned-identity',
        },
        archivePolicy: {
          retentionDays: 30,
          retainIndefinitely: false,
          recordSource: true,
          recordTranslations: true,
        },
        expectedDurationMinutes: 120,
        budgetWarningUsd: 20,
      });
      setSession(await api.start(connection));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const addVoiceProfile = async () => {
    if (!voiceDraft.sample) {
      setError('Choose a clean reference recording before adding the voice.');
      return;
    }
    if (!voiceDraft.consentConfirmed) {
      setError('Confirm the speaker authorization before adding the voice.');
      return;
    }
    if (voiceDraft.sample.size > 25 * 1024 * 1024) {
      setError('The reference recording must be 25 MB or smaller.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const digest = await crypto.subtle.digest('SHA-256', await voiceDraft.sample.arrayBuffer());
      const sampleSha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const created = await api.createVoiceProfile(connection, {
        displayName: voiceDraft.voiceName.trim(),
        referenceLanguage: voiceDraft.referenceLanguage,
        sampleSha256,
        supportedLanguages: ['en'],
        consent: {
          speakerName: voiceDraft.speakerName.trim(),
          confirmedAt: new Date(`${voiceDraft.confirmedDate}T12:00:00Z`).toISOString(),
          authorizerName: voiceDraft.authorizerName.trim(),
          permittedUse: 'AI-generated English interpretation of this speaker at church services',
          permittedLanguages: ['en'],
          evidenceReference: `Operator-recorded confirmation on ${voiceDraft.confirmedDate}`,
        },
      });
      const ready = await api.uploadVoiceSample(connection, created.id, voiceDraft.sample);
      setVoiceProfiles((current) => [ready, ...current.filter((item) => item.id !== ready.id)]);
      setTargets((current) => ({
        ...current,
        en: { ...current.en, outputMode: 'cloned', profileId: ready.id },
      }));
      setVoiceDraft(newVoiceProfileDraft());
      setAddingVoice(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const result = await api.stop(connection);
      setSession(result.session);
      setArchives((current) => [result.archive, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>Multilinguum</strong>
            <span>service console</span>
          </div>
        </div>
        <nav aria-label="Console sections">
          <button className={tab === 'service' ? 'active' : ''} onClick={() => setTab('service')}>
            <span>◉</span> Service
          </button>
          <button className={tab === 'archives' ? 'active' : ''} onClick={() => setTab('archives')}>
            <span>▤</span> Archives
          </button>
          <button
            className={tab === 'connection' ? 'active' : ''}
            onClick={() => setTab('connection')}
          >
            <span>⌁</span> Processing node
          </button>
        </nav>
        <div className="connection-pill">
          <i className={connected ? 'online' : ''} />
          {connected ? 'Processor connected' : 'Processor offline'}
        </div>
      </aside>

      <main>
        <header>
          <div>
            <p className="eyebrow">WORD OF TRUTH · LIVE INTERPRETATION</p>
            <h1>
              {tab === 'service'
                ? 'Sunday service'
                : tab === 'archives'
                  ? 'Service archives'
                  : 'Processing node'}
            </h1>
          </div>
          <div className={`state-badge ${session?.state ?? 'offline'}`}>
            {session?.state ?? 'offline'}
          </div>
        </header>

        {error && <div className="alert">{error}</div>}
        {audioError && <div className="alert muted">Microphone: {audioError}</div>}
        {capture.error && <div className="alert">Capture: {capture.error}</div>}

        {tab === 'service' && (
          <>
            <section className="hero-card">
              <div>
                <p className="eyebrow">SERVICE CONTROL</p>
                <h2>{live ? 'Translation is live' : 'Ready when the room is ready'}</h2>
                <p>
                  {live
                    ? 'Language configuration is locked. Mute, restart, or fall back per channel below.'
                    : 'Confirm the mixer feed, languages, processing node, and estimated spend before starting.'}
                </p>
              </div>
              <button
                className={`start-button ${live ? 'stop' : ''}`}
                disabled={busy}
                onClick={() => void (live ? stop() : start())}
              >
                <span>{live ? '■' : '▶'}</span>
                {busy ? 'Working…' : live ? 'Stop service' : 'Start service'}
              </button>
              {!live && session?.estimatedCostUsd !== undefined && (
                <div className="cost">
                  Estimated two-hour API cost: ${session.estimatedCostUsd.toFixed(2)}
                </div>
              )}
            </section>

            <div className="two-column">
              <section className="panel">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">01 · INPUT</p>
                    <h2>Mixer feed</h2>
                  </div>
                  <span className="ok">
                    {capture.streaming ? 'Streaming' : 'Ready'} · 48 kHz mono · shared input
                  </span>
                </div>
                <label>
                  Audio device
                  <select
                    disabled={live}
                    value={selectedDeviceId ?? ''}
                    onChange={(event) => setSelectedDeviceId(event.target.value || undefined)}
                  >
                    <option value="">System default</option>
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="meter" aria-label={`Input level ${levelDb.toFixed(1)} dBFS`}>
                  <span style={{ width: `${Math.max(1, dbToMeterPercent(levelDb))}%` }} />
                </div>
                <div className="meter-labels">
                  <span>-60 dB</span>
                  <strong>
                    {levelDb.toFixed(1)} dBFS · {signalStatus(levelDb)}
                  </strong>
                  <span>0 dB</span>
                </div>
                <p className="field-note">
                  {Math.round(sampleRate / 1_000)} kHz device ·{' '}
                  {channelCount > 1
                    ? `using channel ${activeChannel + 1} of ${channelCount}`
                    : 'single input channel'}
                  . One shared read-only stream is open; OBS may use the same device.
                </p>
              </section>

              <section className="panel">
                <div className="panel-title">
                  <div>
                    <p className="eyebrow">02 · SOURCE</p>
                    <h2>Pulpit language</h2>
                  </div>
                  <span className="lock">{live ? 'Locked' : 'Editable'}</span>
                </div>
                <div className="segmented">
                  <button
                    disabled={live}
                    className={configuredSource === 'ru' ? 'selected' : ''}
                    onClick={() => changeSource('ru')}
                  >
                    Russian
                  </button>
                  <button
                    disabled={live}
                    className={configuredSource === 'en' ? 'selected' : ''}
                    onClick={() => changeSource('en')}
                  >
                    English
                  </button>
                </div>
                <p className="hint">
                  Pause translation during music. Source language cannot change mid-service.
                </p>
              </section>
            </div>

            <section className="panel channels-panel">
              <div className="panel-title">
                <div>
                  <p className="eyebrow">03 · CHANNELS</p>
                  <h2>Listener languages</h2>
                </div>
                <span>
                  {live && session
                    ? session.targets.length
                    : Object.values(targets).filter((target) => target.enabled).length}{' '}
                  active
                </span>
              </div>
              <div className="channel-grid">
                {displayedLanguages.map((language) => {
                  const liveConfig = live
                    ? session?.targets.find((channel) => channel.targetLanguage === language)
                    : undefined;
                  const draft = liveConfig
                    ? {
                        enabled: true,
                        outputMode: (liveConfig.voiceMode === 'source'
                          ? 'source'
                          : liveConfig.voiceMode === 'cloned'
                            ? 'cloned'
                            : liveConfig.translationProvider === 'openai-realtime'
                              ? 'generic-fast'
                              : 'generic-expressive') as OutputMode,
                        profileId: liveConfig.voiceProfileId,
                      }
                    : targets[language]!;
                  const channelId = liveConfig?.id ?? `channel-${language}`;
                  const itemHealth = health[channelId];
                  const caption = captions[channelId];
                  const sttP95 =
                    itemHealth?.latency?.p95.sourceEndToTranscriptMs ??
                    itemHealth?.latency?.p95.transcriptionMs;
                  const isSource =
                    liveConfig?.voiceMode === 'source' || language === configuredSource;
                  const availableProfiles = voiceProfiles.filter(
                    (profile) =>
                      profile.status === 'ready' &&
                      !profile.consent.revokedAt &&
                      profile.supportedLanguages.includes(language),
                  );
                  const selectedProfile = voiceProfiles.find(
                    (profile) => profile.id === draft.profileId,
                  );
                  return (
                    <article
                      className={`channel-card ${draft.enabled ? '' : 'disabled'}`}
                      key={language}
                    >
                      <div className="channel-heading">
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={draft.enabled}
                            disabled={live || isSource}
                            onChange={(event) =>
                              setTargets((current) => ({
                                ...current,
                                [language]: {
                                  ...current[language]!,
                                  enabled: event.target.checked,
                                },
                              }))
                            }
                          />
                          <span className="language-code">{language.toUpperCase()}</span>
                          <strong>{names[language]}</strong>
                        </label>
                        <span className={`health-dot ${itemHealth?.state ?? 'idle'}`} />
                      </div>
                      <label>
                        Output voice
                        <select
                          value={
                            isSource
                              ? 'source'
                              : draft.outputMode === 'cloned'
                                ? `cloned:${draft.profileId}`
                                : draft.outputMode
                          }
                          disabled={live || isSource || !draft.enabled}
                          onChange={(event) => {
                            if (event.target.value === 'add-cloned') {
                              setAddingVoice(true);
                              return;
                            }
                            const clonedProfileId = event.target.value.startsWith('cloned:')
                              ? event.target.value.slice('cloned:'.length)
                              : '';
                            setTargets((current) => ({
                              ...current,
                              [language]: {
                                ...current[language]!,
                                outputMode: clonedProfileId
                                  ? 'cloned'
                                  : (event.target.value as OutputMode),
                                profileId: clonedProfileId,
                              },
                            }));
                          }}
                        >
                          {isSource && <option value="source">Delayed original</option>}
                          {!isSource && <option value="generic-fast">Generic · Fast</option>}
                          {!isSource && (
                            <option value="generic-expressive">Generic · Expressive</option>
                          )}
                          {!isSource && configuredSource === 'ru' && language === 'en' && (
                            <>
                              {availableProfiles.map((profile) => (
                                <option key={profile.id} value={`cloned:${profile.id}`}>
                                  {profile.displayName} Voice
                                </option>
                              ))}
                              <option value="add-cloned">Add cloned voice…</option>
                            </>
                          )}
                        </select>
                        <span className="field-note">
                          {isSource
                            ? 'The original mixer audio is delayed to stay aligned with captions.'
                            : draft.outputMode === 'generic-fast'
                              ? 'Lowest delay. Speaks while the translation is arriving, with less reliable clause-level cadence.'
                              : draft.outputMode === 'generic-expressive'
                                ? 'Recommended. Waits for a glossary-checked clause, then uses warmer, more deliberate narration.'
                                : `${selectedProfile?.displayName ?? 'Cloned'} voice identity with finalized-clause cadence; automatically falls back if its backlog exceeds 10 seconds.`}
                        </span>
                      </label>
                      <p className="caption">{caption?.text ?? 'No caption yet'}</p>
                      <div className="metrics">
                        <span>{itemHealth?.listenerCount ?? 0} listeners</span>
                        <span>E2E {formatLatency(itemHealth?.latencyMs ?? 0)}</span>
                        {sttP95 !== undefined && <span>STT p95 {formatLatency(sttP95)}</span>}
                        {itemHealth?.latency?.p95.translationMs !== undefined && (
                          <span>
                            Translate p95 {formatLatency(itemHealth.latency.p95.translationMs)}
                          </span>
                        )}
                        {itemHealth?.latency?.p95.speechRenderMs !== undefined && (
                          <span>
                            Voice p95 {formatLatency(itemHealth.latency.p95.speechRenderMs)}
                          </span>
                        )}
                        <span>{itemHealth?.state ?? 'idle'}</span>
                      </div>
                      {live && itemHealth && (
                        <div className="channel-actions">
                          <button
                            onClick={() =>
                              void api.channel(connection, itemHealth.channelId, {
                                muted: itemHealth.state !== 'muted',
                              })
                            }
                          >
                            {itemHealth.state === 'muted' ? 'Unmute' : 'Mute'}
                          </button>
                          {draft.outputMode === 'cloned' && (
                            <button
                              onClick={() =>
                                void api.channel(connection, itemHealth.channelId, {
                                  forceNatural: true,
                                })
                              }
                            >
                              Use natural
                            </button>
                          )}
                          <button
                            onClick={() =>
                              void api.channel(connection, itemHealth.channelId, { restart: true })
                            }
                          >
                            Restart
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
              {addingVoice && (
                <div className="voice-creator">
                  <div className="panel-title">
                    <div>
                      <p className="eyebrow">CONSENTED VOICE</p>
                      <h2>Add cloned voice</h2>
                    </div>
                    <button type="button" onClick={() => setAddingVoice(false)}>
                      Cancel
                    </button>
                  </div>
                  <p className="voice-guidance">
                    For English output, use a clean English recording around 10 seconds with only
                    the speaker—no music, audience, or room echo. A Russian reference can carry a
                    Russian accent into English.
                  </p>
                  <div className="voice-form-grid">
                    <label>
                      First name / voice label
                      <input
                        value={voiceDraft.voiceName}
                        placeholder="Michael"
                        onChange={(event) =>
                          setVoiceDraft((current) => ({
                            ...current,
                            voiceName: event.target.value,
                          }))
                        }
                      />
                      <span className="field-note">
                        Listeners and operators see “Michael Voice”.
                      </span>
                    </label>
                    <label>
                      Speaker's full name
                      <input
                        value={voiceDraft.speakerName}
                        onChange={(event) =>
                          setVoiceDraft((current) => ({
                            ...current,
                            speakerName: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Authorization confirmed by
                      <input
                        value={voiceDraft.authorizerName}
                        onChange={(event) =>
                          setVoiceDraft((current) => ({
                            ...current,
                            authorizerName: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Confirmation date
                      <input
                        type="date"
                        value={voiceDraft.confirmedDate}
                        onChange={(event) =>
                          setVoiceDraft((current) => ({
                            ...current,
                            confirmedDate: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Reference language
                      <select
                        value={voiceDraft.referenceLanguage}
                        onChange={(event) =>
                          setVoiceDraft((current) => ({
                            ...current,
                            referenceLanguage: event.target.value as 'en' | 'ru',
                          }))
                        }
                      >
                        <option value="en">English · recommended for English output</option>
                        <option value="ru">Russian · accent transfer likely</option>
                      </select>
                    </label>
                    <label>
                      Clean reference recording
                      <input
                        type="file"
                        accept="audio/*,.wav"
                        onChange={(event) => {
                          const sample = event.target.files?.[0];
                          if (sample) setVoiceDraft((current) => ({ ...current, sample }));
                        }}
                      />
                    </label>
                  </div>
                  <label className="consent-check">
                    <input
                      type="checkbox"
                      checked={voiceDraft.consentConfirmed}
                      onChange={(event) =>
                        setVoiceDraft((current) => ({
                          ...current,
                          consentConfirmed: event.target.checked,
                        }))
                      }
                    />
                    <span>
                      I have confirmed this speaker authorizes an AI-generated English rendering of
                      their voice for church-service interpretation.
                    </span>
                  </label>
                  <button
                    className="secondary add-voice-button"
                    disabled={
                      busy ||
                      !voiceDraft.voiceName.trim() ||
                      !voiceDraft.speakerName.trim() ||
                      !voiceDraft.authorizerName.trim() ||
                      !voiceDraft.sample ||
                      !voiceDraft.consentConfirmed
                    }
                    onClick={() => void addVoiceProfile()}
                  >
                    {busy ? 'Encrypting and installing…' : 'Add voice'}
                  </button>
                </div>
              )}
            </section>
          </>
        )}

        {tab === 'archives' && (
          <section className="panel archive-panel">
            <div className="panel-title">
              <div>
                <p className="eyebrow">LOCAL RETENTION</p>
                <h2>Recorded services</h2>
              </div>
              <button onClick={() => void refresh()}>Refresh</button>
            </div>
            {archives.length === 0 && <div className="empty">No completed services yet.</div>}
            {archives.map((archive) => {
              const p95Latency = archiveP95Latency(archive);
              return (
                <article className="archive-row" key={archive.sessionId}>
                  <div>
                    <strong>{new Date(archive.createdAt).toLocaleString()}</strong>
                    <span>
                      {archive.audioTracks.length} audio tracks · {archive.transcripts.length}{' '}
                      transcripts
                    </span>
                    <span>
                      {archive.latencyReport.sampleCount} timing samples
                      {p95Latency === undefined ? '' : ` · p95 ${formatLatency(p95Latency)}`}
                    </span>
                  </div>
                  <div>
                    <span>
                      {archive.retained
                        ? 'Retained'
                        : `Expires ${new Date(archive.retentionDeadline).toLocaleDateString()}`}
                    </span>
                    <code>{archive.integritySha256?.slice(0, 12) ?? 'recording'}</code>
                  </div>
                  <div className="archive-actions">
                    <button
                      onClick={() =>
                        void api
                          .retain(connection, archive.sessionId, !archive.retained)
                          .then(refresh)
                      }
                    >
                      {archive.retained ? 'Resume expiry' : 'Retain'}
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (window.confirm('Permanently delete this local archive?'))
                          void api.deleteArchive(connection, archive.sessionId).then(refresh);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  <div className="archive-tracks">
                    <span>Playback</span>
                    {archive.audioTracks.map((track) => (
                      <button
                        key={track.channelId}
                        disabled={!track.sha256}
                        onClick={() => void playArchive(archive.sessionId, track.channelId)}
                      >
                        {track.language.toUpperCase()}
                      </button>
                    ))}
                    <span>Transcripts</span>
                    {archive.transcripts.map((transcript) => (
                      <button
                        key={transcript.channelId}
                        disabled={!transcript.sha256}
                        onClick={() =>
                          void exportTranscript(
                            archive.sessionId,
                            transcript.channelId,
                            transcript.language,
                          )
                        }
                      >
                        Export {transcript.language.toUpperCase()}
                      </button>
                    ))}
                    <span>Diagnostics</span>
                    <button
                      disabled={!archive.latencyReport.sha256}
                      onClick={() => void exportLatency(archive.sessionId)}
                    >
                      Export timing
                    </button>
                  </div>
                </article>
              );
            })}
            {playbackUrl && (
              <div className="archive-player">
                <strong>Archive playback</strong>
                <audio controls autoPlay src={playbackUrl} />
              </div>
            )}
          </section>
        )}

        {tab === 'connection' && (
          <div className="two-column">
            <section className="panel">
              <p className="eyebrow">PROCESSOR</p>
              <h2>Endpoint</h2>
              <label>
                Processor URL
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              </label>
              <label>
                Paired control credential
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              <button className="secondary" onClick={() => void refresh()}>
                Test connection
              </button>
              <p className="hint">
                Provider API keys remain on the processor. This console stores only its paired
                control credential.
              </p>
            </section>
            <section className="panel">
              <p className="eyebrow">PREFLIGHT</p>
              <h2>Capability report</h2>
              <pre>{preflight ? JSON.stringify(preflight, null, 2) : 'Processor unavailable'}</pre>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
