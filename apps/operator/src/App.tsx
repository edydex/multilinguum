import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ArchiveManifest,
  ChannelConfig,
  ChannelHealth,
  Language,
  ProcessorEvent,
  ServiceSession,
  TranscriptSegment,
  VoiceMode,
} from '@multilinguum/protocol';
import { api, subscribe, type OperatorConnection } from './api';
import { useAudioMeter } from './useAudioMeter';
import { useAudioStreamer } from './useAudioStreamer';

const names: Record<Language, string> = {
  en: 'English',
  ru: 'Russian',
  es: 'Spanish',
  uk: 'Ukrainian',
};

const allLanguages: Language[] = ['en', 'ru', 'es', 'uk'];

interface TargetDraft {
  enabled: boolean;
  voiceMode: VoiceMode;
  profileId: string;
}

function initialTargets(source: 'en' | 'ru'): Record<Language, TargetDraft> {
  return Object.fromEntries(
    allLanguages.map((language) => [
      language,
      {
        enabled: true,
        voiceMode: language === source ? 'source' : 'natural',
        profileId: '',
      },
    ]),
  ) as Record<Language, TargetDraft>;
}

function formatLatency(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
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
  const [preflight, setPreflight] = useState<Record<string, unknown>>();
  const [source, setSource] = useState<'en' | 'ru'>('ru');
  const [targets, setTargets] = useState(() => initialTargets('ru'));
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [playbackUrl, setPlaybackUrl] = useState<string>();
  const { devices, level, error: audioError } = useAudioMeter(selectedDeviceId);

  const connection = useMemo<OperatorConnection>(() => ({ baseUrl, token }), [baseUrl, token]);
  const live = session?.state === 'live' || session?.state === 'starting';
  const capture = useAudioStreamer(
    session?.state === 'live',
    session?.id,
    selectedDeviceId,
    connection,
  );

  const refresh = useCallback(async () => {
    try {
      const [current, nextPreflight, nextArchives] = await Promise.all([
        api.current(connection),
        api.preflight(connection),
        api.archives(connection),
      ]);
      setSession(current.session);
      setHealth(Object.fromEntries(current.health.map((item) => [item.channelId, item])));
      setPreflight(nextPreflight);
      setArchives(nextArchives);
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

  const changeSource = (nextSource: 'en' | 'ru') => {
    setSource(nextSource);
    setTargets((current) => {
      const next = structuredClone(current);
      for (const language of allLanguages) {
        const previous = next[language]!;
        if (language === nextSource) {
          next[language] = { ...previous, enabled: true, voiceMode: 'source' };
        } else if (previous.voiceMode === 'source') {
          next[language] = { ...previous, voiceMode: 'natural' };
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
            translationProvider: 'openai-realtime',
            voiceMode: language === source ? 'source' : draft.voiceMode,
            ...(draft.voiceMode === 'cloned' && draft.profileId
              ? { voiceProfileId: draft.profileId }
              : {}),
            fallbackOrder: draft.voiceMode === 'cloned' ? ['natural', 'mute'] : ['mute'],
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
                    {capture.streaming ? 'Streaming · 48 kHz mono' : '48 kHz mono'}
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
                <div
                  className="meter"
                  aria-label={`Input level ${Math.round(level * 100)} percent`}
                >
                  <span style={{ width: `${Math.max(2, level * 100)}%` }} />
                </div>
                <div className="meter-labels">
                  <span>-60 dB</span>
                  <strong>
                    {level > 0.7 ? 'Hot' : level > 0.08 ? 'Good signal' : 'Waiting for signal'}
                  </strong>
                  <span>0 dB</span>
                </div>
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
                    className={source === 'ru' ? 'selected' : ''}
                    onClick={() => changeSource('ru')}
                  >
                    Russian
                  </button>
                  <button
                    disabled={live}
                    className={source === 'en' ? 'selected' : ''}
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
                  {Object.values(targets).filter((target) => target.enabled).length} active
                </span>
              </div>
              <div className="channel-grid">
                {allLanguages.map((language) => {
                  const draft = targets[language]!;
                  const itemHealth = health[`channel-${language}`];
                  const caption = captions[`channel-${language}`];
                  const isSource = language === source;
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
                        Voice
                        <select
                          value={isSource ? 'source' : draft.voiceMode}
                          disabled={live || isSource || !draft.enabled}
                          onChange={(event) =>
                            setTargets((current) => ({
                              ...current,
                              [language]: {
                                ...current[language]!,
                                voiceMode: event.target.value as VoiceMode,
                              },
                            }))
                          }
                        >
                          {isSource && <option value="source">Delayed original</option>}
                          {!isSource && <option value="natural">Natural AI voice</option>}
                          {!isSource && source === 'ru' && language === 'en' && (
                            <option value="cloned">Consented preacher voice</option>
                          )}
                        </select>
                      </label>
                      {draft.voiceMode === 'cloned' && !isSource && (
                        <label>
                          Voice profile ID
                          <input
                            value={draft.profileId}
                            disabled={live}
                            onChange={(event) =>
                              setTargets((current) => ({
                                ...current,
                                [language]: {
                                  ...current[language]!,
                                  profileId: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      )}
                      <p className="caption">{caption?.text ?? 'No caption yet'}</p>
                      <div className="metrics">
                        <span>{itemHealth?.listenerCount ?? 0} listeners</span>
                        <span>{formatLatency(itemHealth?.latencyMs ?? 0)}</span>
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
                          {draft.voiceMode === 'cloned' && (
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
            {archives.map((archive) => (
              <article className="archive-row" key={archive.sessionId}>
                <div>
                  <strong>{new Date(archive.createdAt).toLocaleString()}</strong>
                  <span>
                    {archive.audioTracks.length} audio tracks · {archive.transcripts.length}{' '}
                    transcripts
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
                </div>
              </article>
            ))}
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
