import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  TranscriptSegment,
  TranslationProfileId,
  TranslationProfileInfo,
} from '@multilinguum/protocol';
import { api, operatorUrl, subscribe } from './api';
import { useAudioMeter } from './useAudioMeter';
import { useAudioStreamer } from './useAudioStreamer';
import { dbToMeterPercent, signalStatus } from './audioLevel';

export interface ControlLease {
  token: string;
  expiresAtUnixMs: number;
  apiBase: string;
}
export interface ManagedOperatorOptions {
  initialLease: ControlLease;
  requestAccess(): Promise<ControlLease>;
}
type Snapshot = Awaited<ReturnType<typeof api.current>>;
type Preflight = {
  openai?: { configured: boolean };
  livekit?: { configured: boolean };
  translationProfiles?: TranslationProfileInfo[];
};
const names = { en: 'English', ru: 'Russian', es: 'Spanish', uk: 'Ukrainian' };

export function ManagedOperator({ initialLease, requestAccess }: ManagedOperatorOptions) {
  const [lease, setLease] = useState(initialLease);
  const [accessError, setAccessError] = useState('');
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>({
    health: [],
    capture: { connected: false, ready: false },
  });
  const [preflight, setPreflight] = useState<Preflight>();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<'en' | 'ru'>('en');
  const [speech, setSpeech] = useState(false);
  const [profileId, setProfileId] = useState<TranslationProfileId>('quality');
  const [captureRequested, setCaptureRequested] = useState(false);
  const [deviceId, setDeviceId] = useState<string>();
  const [captions, setCaptions] = useState<TranscriptSegment[]>([]);
  const subscription = useRef<ReturnType<typeof subscribe> | undefined>(undefined);
  const connection = useMemo(() => ({ baseUrl: lease.apiBase, token: lease.token }), [lease]);
  const latestConnection = useRef(connection);
  latestConnection.current = connection;
  const session = snapshot.session;
  const live = session?.state === 'live';
  const locked = Boolean(session && !['completed', 'failed'].includes(session.state));
  const expired = lease.expiresAtUnixMs <= Date.now();
  const audio = useAudioMeter(
    deviceId,
    captureRequested && !expired,
    operatorUrl('client/pcm-worklet.js', lease.apiBase).href,
  );
  const capture = useAudioStreamer(
    captureRequested && live && !expired,
    session?.id,
    connection,
    audio.subscribePcm,
  );

  useEffect(() => {
    let stopped = false;
    let timer: number;
    const renew = async () => {
      try {
        const next = await requestAccess();
        if (stopped) return;
        if (next.apiBase !== initialLease.apiBase)
          throw new Error('The translation server changed. Reopen these controls.');
        setLease(next);
        setAccessError('');
        timer = window.setTimeout(renew, 120000);
      } catch (cause) {
        if (stopped) return;
        setAccessError(cause instanceof Error ? cause.message : 'Could not renew control access.');
        timer = window.setTimeout(renew, 15000);
      }
    };
    timer = window.setTimeout(renew, 120000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [requestAccess, initialLease.apiBase]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        setCaptureRequested(false);
        setAccessError('Control access expired. Sign in again to reconnect the mixer.');
      },
      Math.max(0, lease.expiresAtUnixMs - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [lease]);

  useEffect(() => {
    let stopped = false;
    let timer: number;
    const refresh = async () => {
      try {
        const current = await api.current(latestConnection.current);
        if (!stopped) setSnapshot(current);
      } catch (cause) {
        if (!stopped)
          setError(cause instanceof Error ? cause.message : 'Could not read the service.');
      }
      if (!stopped) timer = window.setTimeout(refresh, 2000);
    };
    void refresh();
    void api
      .preflight(latestConnection.current)
      .then((value) => {
        if (!stopped) setPreflight(value);
      })
      .catch(() => undefined);
    subscription.current = subscribe(
      latestConnection.current,
      (event) => {
        if (event.type === 'transcript')
          setCaptions((previous) =>
            [...previous.filter((item) => item.id !== event.segment.id), event.segment].slice(-12),
          );
        if (event.type === 'session')
          setSnapshot((previous) => ({ ...previous, session: event.session }));
        if (event.type === 'error') setError(event.message);
      },
      setConnected,
    );
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      subscription.current?.();
      subscription.current = undefined;
    };
  }, [lease.apiBase]);
  useEffect(() => subscription.current?.renew(lease.token), [lease.token]);
  useEffect(() => setCaptions([]), [session?.id]);
  useEffect(() => {
    if (capture.error || audio.error) {
      setError(capture.error || audio.error || 'Audio input disconnected.');
      setCaptureRequested(false);
    }
  }, [capture.error, audio.error]);

  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      setSnapshot(await api.current(latestConnection.current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update live translation.');
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (!locked) {
      await api.create(connection, {
        translationProfile: profileId,
        sourceLanguage: source,
        targets: (['en', 'ru'] as const).map((language) => ({
          id: `channel-${language}`,
          targetLanguage: language,
          translationProvider: language === source ? 'deterministic' : 'openai-cascade',
          voiceMode: language === source ? 'source' : 'natural',
          fallbackOrder: ['mute'],
          muted: false,
          speechEnabled: language !== source && speech,
        })),
        processingNode: {
          id: 'community-processor',
          name: 'Church translation',
          mode: 'remote',
          endpoint: lease.apiBase,
          identityFingerprint: 'community-authorized-processor',
        },
        archivePolicy: {
          retentionDays: 30,
          retainIndefinitely: false,
          recordSource: true,
          recordTranslations: true,
        },
        contextDocumentIds: [],
        expectedDurationMinutes: 120,
        budgetWarningUsd: 20,
      });
    }
    await api.start(connection);
  }
  const shownSource = locked && session ? session.sourceLanguage : source;
  const selectedProfile = locked
    ? session?.translationProfile
    : preflight?.translationProfiles?.find((profile) => profile.id === profileId);
  const profileReady =
    locked && !session?.translationProfile ? preflight?.openai?.configured : selectedProfile?.ready;
  const translated =
    session?.targets.filter((channel) => channel.targetLanguage !== session.sourceLanguage) ?? [];
  const speechEnabled = locked
    ? translated.some((channel) => channel.speechEnabled !== false)
    : speech;
  const toggleSpeech = (enabled: boolean) =>
    live
      ? void act(async () => {
          for (const channel of translated)
            await api.channel(connection, channel.id, { speechEnabled: enabled });
        })
      : setSpeech(enabled);
  const inputError = capture.error || audio.error;

  return (
    <main className="managed-operator">
      <header>
        <div>
          <p className="eyebrow">CHURCH SERVICE</p>
          <h1>Live translation</h1>
          <p>
            Start here or in SyncShow. Connect the mixer on the computer receiving the church’s
            audio.
          </p>
        </div>
        <span className={`status ${live ? 'live' : ''}`}>
          {connected ? (live ? 'Live' : 'Connected') : 'Connecting…'}
        </span>
      </header>
      {(error || accessError || inputError) && (
        <p className="notice" role="alert">
          {accessError || error || inputError}
        </p>
      )}
      <div className="setup-grid">
        <section className="card">
          <h2>Translation</h2>
          <label>
            Speaker’s language
            <select
              value={shownSource}
              disabled={locked || busy}
              onChange={(event) => setSource(event.target.value as 'en' | 'ru')}
            >
              <option value="en">English → Russian</option>
              <option value="ru">Russian → English</option>
            </select>
          </label>
          <label>
            Translation quality
            <select
              value={locked && !selectedProfile ? 'legacy' : (selectedProfile?.id ?? profileId)}
              disabled={locked || busy}
              onChange={(event) => setProfileId(event.target.value as TranslationProfileId)}
            >
              {locked && !selectedProfile && (
                <option value="legacy">Existing server configuration</option>
              )}
              <option value="quality">Quality</option>
              <option value="economy">Economy · shared-data allowance</option>
            </select>
          </label>
          {selectedProfile && (
            <div className="profile-details">
              {!selectedProfile.ready && (
                <p className="notice">{selectedProfile.unavailableReason}</p>
              )}
              {selectedProfile.id === 'economy' && (
                <p className="hint">
                  Uses a sharing project for spoken text. Eligible usage may be covered; audio and
                  usage beyond the allowance can incur charges.
                </p>
              )}
              <details>
                <summary>Models and estimated charges</summary>
                <p className="hint">
                  Text: {selectedProfile.textModel} · Recognition:{' '}
                  {selectedProfile.transcriptionModel}
                </p>
                <p className="hint">
                  {selectedProfile.rates.textInputPerMillionUsd !== null &&
                  selectedProfile.rates.textOutputPerMillionUsd !== null
                    ? `Text list price: $${selectedProfile.rates.textInputPerMillionUsd} input / $${selectedProfile.rates.textOutputPerMillionUsd} output per million tokens.`
                    : 'Check the configured text model’s current price in OpenAI settings.'}{' '}
                  {selectedProfile.rates.transcriptionPerMinuteUsd !== null
                    ? `Recognition: about $${(60 * selectedProfile.rates.transcriptionPerMinuteUsd).toFixed(2)} per hour.`
                    : 'Recognition is billed separately.'}
                </p>
                {selectedProfile.id === 'economy' && (
                  <p className="hint">
                    Spoken text and translation context go to the configured sharing project.
                    Private note attachments are excluded. OpenAI may cover eligible text usage;
                    remaining allowance is unverified. Recognition and voice are additional charges.
                    {selectedProfile.overagePolicy === 'allow-billed' &&
                      ' Billed overage is allowed by server setup.'}
                  </p>
                )}
                <p className="hint">
                  Model access, translation quality, and live delay still need a mixer rehearsal.
                </p>
              </details>
            </div>
          )}
          {!preflight?.translationProfiles && preflight && !locked && (
            <p className="notice">
              Update the translation processor to enable Quality and Economy.
            </p>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={speechEnabled}
              disabled={
                busy ||
                expired ||
                (!speechEnabled && !preflight?.livekit?.configured) ||
                (locked && !live)
              }
              onChange={(event) => toggleSpeech(event.target.checked)}
            />
            Generate translated speech
          </label>
          <p>Text continues when speech is off. Turning speech off cancels queued voice output.</p>
          {!preflight?.livekit?.configured && (
            <p className="hint">Audio relay setup is needed for translated speech.</p>
          )}
          <div className="actions">
            {!live ? (
              <button
                className="primary"
                disabled={
                  busy || expired || !profileReady || (locked && session?.state !== 'preflight')
                }
                onClick={() => void act(start)}
              >
                {busy ? 'Starting…' : locked ? 'Start prepared translation' : 'Start translation'}
              </button>
            ) : (
              <button
                className="stop"
                disabled={busy || expired}
                onClick={() =>
                  void act(async () => {
                    setCaptureRequested(false);
                    await api.stop(connection);
                  })
                }
              >
                {busy ? 'Stopping…' : 'Stop translation'}
              </button>
            )}
            {session?.state === 'preflight' && (
              <button
                disabled={busy || expired}
                onClick={() =>
                  void act(async () => {
                    await api.stop(connection);
                  })
                }
              >
                Cancel preparation
              </button>
            )}
            <a href="/translate" target="_blank" rel="noreferrer">
              Open congregation screen ↗
            </a>
          </div>
          <p className="hint">
            {speechEnabled && selectedProfile
              ? `Voice: ${selectedProfile.speechModel}, billed separately. `
              : ''}
            Prices are estimates, not a spending limit. Turn voice off to stop speech generation.
          </p>
        </section>
        <section className="card">
          <h2>Mixer feed</h2>
          <p className="input-status">
            {capture.streaming
              ? 'Sending audio from this computer'
              : captureRequested
                ? 'Connecting this input…'
                : snapshot.capture.ready
                  ? 'Another console is sending audio'
                  : snapshot.capture.connected
                    ? 'Another console is connecting'
                    : 'No mixer connected'}
          </p>
          <label>
            Audio device
            <select
              value={deviceId ?? ''}
              disabled={captureRequested}
              onChange={(event) => setDeviceId(event.target.value || undefined)}
            >
              <option value="">System default</option>
              {audio.devices.map((device, index) => (
                <option key={`${device.id}-${index}`} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <meter min={-60} max={0} value={audio.levelDb} aria-label="Mixer input level" />
          <p className="hint">
            {captureRequested
              ? `${signalStatus(audio.levelDb)} · ${Math.round(dbToMeterPercent(audio.levelDb))}%`
              : 'Opening these controls does not activate your microphone.'}
          </p>
          <button
            disabled={expired || (!captureRequested && snapshot.capture.connected)}
            onClick={() => setCaptureRequested((value) => !value)}
          >
            {captureRequested ? 'Disconnect this mixer' : 'Connect this mixer'}
          </button>
          {captureRequested && !live && (
            <p className="hint">
              Input is open locally. Start translation to send it to the processor.
            </p>
          )}
        </section>
      </div>
      <section className="card">
        <h2>Live text</h2>
        <div className="captions">
          {(['en', 'ru'] as const).map((language) => (
            <section key={language} lang={language}>
              <h3>{names[language]}</h3>
              {captions
                .filter((item) => item.language === language)
                .slice(-3)
                .map((item) => (
                  <p key={item.id}>{item.text}</p>
                ))}
              {!captions.some((item) => item.language === language) && (
                <p className="hint">
                  {live ? 'Waiting for speech…' : 'Text will appear when the service starts.'}
                </p>
              )}
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
