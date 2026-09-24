import {
  SlideAutomation,
  type SlideAutomationBridge,
  type SlideTranslationStatus,
} from './slideAutomation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContextDocument,
  TranscriptSegment,
  TranslationProfileId,
  TranslationProfileInfo,
} from '@multilinguum/protocol';
import {
  sameSettings,
  serviceReference,
  type ServicePlanOptions,
  type ServiceTranslationPlan,
  type TranslationSettings,
} from './servicePlans';
import { api, operatorUrl, subscribe } from './api';
import { useAudioMeter } from './useAudioMeter';
import { useAudioStreamer } from './useAudioStreamer';
import { dbToMeterPercent, signalStatus } from './audioLevel';
import { ManagedArchives } from './ManagedArchives';
import { ServiceUsagePanel } from './ServiceUsagePanel';
import { recognitionRateUsd } from '@multilinguum/protocol';
import { MuseSettings, type MuseSettingsAccess } from './MuseSettings';

export interface ControlLease {
  token: string;
  expiresAtUnixMs: number;
  apiBase: string;
}
export interface ManagedOperatorOptions extends ServicePlanOptions {
  museSettings?: MuseSettingsAccess;
  slideAutomation?: SlideAutomationBridge;
  initialLease: ControlLease;
  requestAccess(): Promise<ControlLease>;
  requestArchiveAccess?(): Promise<ControlLease>;
}
type Snapshot = Awaited<ReturnType<typeof api.current>>;
type Preflight = {
  transcription?: {
    muse: { configured: boolean };
    english: { provider: string; model: string; ready: boolean; detail: string };
    russian: { provider: string; model: string; ready: boolean; detail: string };
  };
  openai?: { configured: boolean };
  translationProfiles?: TranslationProfileInfo[];
};
const names = { en: 'English', ru: 'Russian', es: 'Spanish', uk: 'Ukrainian' };

export function ManagedOperator({
  initialLease,
  requestAccess,
  requestArchiveAccess,
  loadServicePlans,
  saveServicePlan,
  preferredServiceId,
  museSettings,
  slideAutomation,
}: ManagedOperatorOptions) {
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
  const [plans, setPlans] = useState<ServiceTranslationPlan[]>([]);
  const [serviceId, setServiceId] = useState(preferredServiceId ?? '');
  const [planBusy, setPlanBusy] = useState(Boolean(loadServicePlans));
  const [planError, setPlanError] = useState('');
  const [planNotice, setPlanNotice] = useState('');
  const [source, setSource] = useState<'en' | 'ru'>('en');
  const [speech, setSpeech] = useState(false);
  const [profileId, setProfileId] = useState<TranslationProfileId>('quality');
  const [recognition, setRecognition] = useState<'auto' | 'muse' | 'openai'>('auto');
  const [useNotes, setUseNotes] = useState(false);
  const [documents, setDocuments] = useState<ContextDocument[]>([]);
  const [noteIds, setNoteIds] = useState<string[]>([]);
  const [shareNotes, setShareNotes] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [captureRequested, setCaptureRequested] = useState(false);
  const [deviceId, setDeviceId] = useState<string>();
  const [automationSessionId, setAutomationSessionId] = useState<string>();
  const [automationStatus, setAutomationStatus] = useState<SlideTranslationStatus>({
    phase: 'idle',
  });
  const [captions, setCaptions] = useState<TranscriptSegment[]>([]);
  const subscription = useRef<ReturnType<typeof subscribe> | undefined>(undefined);
  const connection = useMemo(() => ({ baseUrl: lease.apiBase, token: lease.token }), [lease]);
  const latestConnection = useRef(connection);
  latestConnection.current = connection;
  const session = snapshot.session;
  const live = session?.state === 'live';
  const locked = Boolean(session && !['completed', 'failed'].includes(session.state));
  const expired = lease.expiresAtUnixMs <= Date.now();
  const selectedService = plans.find((plan) => plan.id === serviceId);
  const settings: TranslationSettings = {
    transcriptionProvider: recognition,
    sourceLanguage: source,
    translationProfile: profileId,
    speechEnabled: speech,
    shareSermonNotesWithEconomy: useNotes && profileId === 'economy' && shareNotes,
    contextDocumentIds: useNotes ? noteIds : [],
  };
  const planReady =
    !serviceId ||
    Boolean(
      selectedService?.revision &&
      !selectedService.stale &&
      sameSettings(settings, selectedService.settings),
    );
  const latestLocked = useRef(locked);
  latestLocked.current = locked;
  function applyPlan(plan: ServiceTranslationPlan | undefined) {
    setShareNotes(false);
    if (plan?.settings && !latestLocked.current) {
      setSource(plan.settings.sourceLanguage);
      setRecognition(plan.settings.transcriptionProvider ?? 'auto');
      setProfileId(plan.settings.translationProfile);
      setSpeech(plan.settings.speechEnabled);
      setNoteIds(plan.settings.contextDocumentIds);
      setUseNotes(plan.settings.contextDocumentIds.length > 0);
      setShareNotes(plan.settings.shareSermonNotesWithEconomy === true);
    }
  }
  async function reloadPlans() {
    if (!loadServicePlans || planBusy || busy || locked) return;
    setPlanBusy(true);
    setPlanError('');
    setPlanNotice('');
    try {
      const list = await loadServicePlans();
      const exact = serviceId ? await loadServicePlans(serviceId) : undefined;
      const values = [
        ...list.services.filter((item) => item.id !== serviceId),
        ...(exact?.services ?? []),
      ];
      setPlans(values);
      applyPlan(values.find((item) => item.id === serviceId));
      setError('');
    } catch (cause) {
      setPlanError(cause instanceof Error ? cause.message : 'Could not load prepared services.');
    } finally {
      setPlanBusy(false);
    }
  }
  useEffect(() => {
    if (!loadServicePlans) return;
    let stopped = false;
    void (async () => {
      try {
        const list = await loadServicePlans();
        const exact = preferredServiceId ? await loadServicePlans(preferredServiceId) : undefined;
        if (stopped) return;
        const values = [
          ...list.services.filter((item) => item.id !== preferredServiceId),
          ...(exact?.services ?? []),
        ];
        setPlans(values);
        applyPlan(values.find((item) => item.id === preferredServiceId));
      } catch (cause) {
        if (!stopped)
          setPlanError(
            cause instanceof Error ? cause.message : 'Could not load prepared services.',
          );
      } finally {
        if (!stopped) setPlanBusy(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [loadServicePlans, preferredServiceId]);
  const audio = useAudioMeter(
    deviceId,
    captureRequested && !expired,
    operatorUrl('client/pcm-worklet.js', lease.apiBase).href,
  );
  const capture = useAudioStreamer(
    captureRequested && (live || Boolean(automationSessionId)) && !expired,
    automationSessionId || session?.id,
    connection,
    audio.subscribePcm,
    live,
  );

  const cueController = useRef<SlideAutomation | undefined>(undefined);
  const inputState = useRef({ audio, capture });
  inputState.current = { audio, capture };
  const meterFrames = useRef(0);
  useEffect(() => {
    const off = audio.subscribePcm(() => {
      meterFrames.current++;
    });
    return () => {
      off();
    };
  }, [audio.subscribePcm]);
  useEffect(() => {
    if (!slideAutomation) return;
    let closed = false;
    void slideAutomation.getInput().then((input) => {
      if (input && !closed) setDeviceId(input.id);
    });
    const disconnect = () => {
      setCaptureRequested(false);
      setAutomationSessionId(undefined);
    };
    const controller = new SlideAutomation({
      report: (status) => {
        if (!closed) {
          setAutomationStatus(status);
          slideAutomation.report(status);
        }
      },
      disconnect,
      prepare: async (command, cancelled) => {
        if (!loadServicePlans) throw new Error('Update Community to use translation cues.');
        const input = await slideAutomation.getInput();
        if (!input || ['default', 'communications'].includes(input.id))
          throw new Error(
            'Choose and save the mixer or incoming audio device in Translation controls first.',
          );
        const available = await navigator.mediaDevices.enumerateDevices();
        const exact = available.find(
          (device) =>
            device.kind === 'audioinput' &&
            device.deviceId === input.id &&
            (!device.label || device.label === input.label),
        );
        const matches = available.filter(
          (device) =>
            device.kind === 'audioinput' &&
            device.label === input.label &&
            !['default', 'communications'].includes(device.deviceId),
        );
        const chosen =
          input.id === 'syncshow:computer-audio' && slideAutomation.computerAudio
            ? { deviceId: input.id }
            : exact || (matches.length === 1 ? matches[0] : undefined);
        if (!chosen)
          throw new Error(
            'The saved mixer input is unavailable. Reconnect it or choose an input in Translation controls.',
          );
        const plan = (await loadServicePlans(command.serviceId)).services.find(
          (value) => value.id === command.serviceId,
        );
        const cue = plan?.translationCues?.find((value) => value.id === command.segmentId);
        if (
          !plan ||
          (!cue && (!plan.settings || !plan.revision || plan.stale)) ||
          plan.serviceRevision !== command.serviceRevision
        ) {
          throw new Error(
            'Save translation settings for this service, then load the current service in SyncShow.',
          );
        }
        if (cancelled()) throw new Error('Translation preparation was cancelled.');
        const settings = cue
          ? {
              transcriptionProvider: plan.settings?.transcriptionProvider ?? ('auto' as const),
              translationProfile: plan.settings?.translationProfile || ('quality' as const),
              contextDocumentIds: plan.stale ? [] : plan.settings?.contextDocumentIds || [],
              shareSermonNotesWithEconomy:
                !plan.stale && plan.settings?.shareSermonNotesWithEconomy === true,
              sourceLanguage: cue.settings.sourceLanguage,
              speechEnabled: cue.settings.speechEnabled,
            }
          : plan.settings!;
        if (
          settings.translationProfile === 'economy' &&
          settings.contextDocumentIds.length &&
          !settings.shareSermonNotesWithEconomy
        )
          throw new Error('Confirm Economy note sharing in this service’s translation settings.');
        const current = await api.current(latestConnection.current);
        if (current.session && !['completed', 'failed'].includes(current.session.state)) {
          throw new Error(
            'Another translation session is already active. Open Translation controls to review it.',
          );
        }
        setServiceId(plan.id);
        setPlans((values) => [...values.filter((value) => value.id !== plan.id), plan]);
        applyPlan(plan);
        const created = await api.create(latestConnection.current, {
          serviceReference: cue
            ? {
                communityId: plan.communityId,
                serviceId: plan.id,
                title: plan.title,
                serviceDate: plan.serviceDate,
                serviceRevision: plan.serviceRevision,
                planRevision: Math.max(1, plan.revision),
              }
            : serviceReference(plan, plan, settings),
          transcriptionProvider: settings.transcriptionProvider ?? 'auto',
          sourceLanguage: settings.sourceLanguage,
          translationProfile: settings.translationProfile,
          targets: (['en', 'ru'] as const).map((language) => ({
            id: `channel-${language}`,
            targetLanguage: language,
            translationProvider:
              language === settings.sourceLanguage ? 'deterministic' : 'openai-cascade',
            voiceMode: language === settings.sourceLanguage ? 'source' : 'natural',
            ...(cue ? { speechVoice: cue.settings.voice } : {}),
            fallbackOrder: ['mute'],
            muted: false,
            speechEnabled: language !== settings.sourceLanguage && settings.speechEnabled,
          })),
          processingNode: {
            id: 'community-processor',
            name: 'Church translation',
            mode: 'remote',
            endpoint: latestConnection.current.baseUrl,
            identityFingerprint: 'community-authorized-processor',
          },
          archivePolicy: {
            retentionDays: 30,
            retainIndefinitely: false,
            recordSource: true,
            recordTranslations: true,
          },
          contextDocumentIds: settings.contextDocumentIds,
          shareSermonNotesWithEconomy: settings.shareSermonNotesWithEconomy === true,
          expectedDurationMinutes: 120,
          budgetWarningUsd: 20,
        });
        if (cancelled()) return created.id;
        meterFrames.current = 0;
        setDeviceId(chosen.deviceId);
        setSnapshot((previous) => ({ ...previous, session: created }));
        setAutomationSessionId(created.id);
        setCaptureRequested(true);
        return created.id;
      },
      ready: async (_id, cancelled) => {
        const deadline = Date.now() + 25000;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        // Wait for actual local PCM and the server's provider-ready acknowledgement.
        while (!cancelled() && !closed) {
          const current = inputState.current;
          if (current.audio.error || current.capture.error)
            throw new Error(current.audio.error || current.capture.error);
          if (meterFrames.current > 0 && current.capture.streaming) return;
          if (Date.now() > deadline)
            throw new Error(
              'The selected audio input or translation provider did not become ready.',
            );
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
      },
      start: async (id) => {
        const current = await api.current(latestConnection.current);
        const started =
          current.session?.id === id && current.session.state === 'live'
            ? current.session
            : await api.start(latestConnection.current, id);
        setSnapshot((previous) => ({ ...previous, session: started }));
      },
      stop: async (id) => {
        const current = await api.current(latestConnection.current);
        if (current.session?.id !== id || ['completed', 'failed'].includes(current.session.state))
          return;
        const stopped = await api.stop(latestConnection.current, id);
        setSnapshot((previous) => ({ ...previous, session: stopped.session }));
      },
    });
    cueController.current = controller;
    const unsubscribe = slideAutomation.onCommand((command) => controller.command(command));
    return () => {
      closed = true;
      unsubscribe();
      controller.dispose();
      if (cueController.current === controller) cueController.current = undefined;
      disconnect();
    };
  }, [slideAutomation, loadServicePlans]);
  useEffect(() => {
    if (
      automationSessionId &&
      ['ready', 'live'].includes(automationStatus.phase) &&
      (audio.error || capture.error)
    ) {
      cueController.current?.fail(audio.error || capture.error || 'Audio input disconnected.');
    }
  }, [automationSessionId, automationStatus.phase, audio.error, capture.error]);
  // Store a named input after explicit selection; never save a system-default alias.
  useEffect(() => {
    const selected =
      deviceId === 'syncshow:computer-audio' && slideAutomation?.computerAudio
        ? { id: deviceId, label: 'Computer audio (all apps)' }
        : audio.devices.find((device) => device.id === deviceId);
    if (
      slideAutomation &&
      selected &&
      !['default', 'communications'].includes(selected.id) &&
      !/^Input \d+$/.test(selected.label)
    ) {
      void slideAutomation
        .saveInput(selected)
        .catch(() => setError('Could not save the selected mixer input.'));
    }
  }, [slideAutomation, audio.devices, deviceId]);

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
      .contextDocuments(latestConnection.current)
      .then((value) => {
        if (!stopped) {
          setDocuments(value);
          setNotesError('');
        }
      })
      .catch(() => {
        if (!stopped)
          setNotesError(
            'Could not load sermon notes. Upload notes or reopen these controls to retry.',
          );
      });
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
        if (event.type === 'cost' && event.usage) {
          const usage = event.usage;
          setSnapshot((previous) =>
            previous.session && previous.session.id === event.sessionId
              ? {
                  ...previous,
                  session: {
                    ...previous.session,
                    usage,
                    estimatedCostUsd: event.estimatedCostUsd,
                  },
                }
              : previous,
          );
        }
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
      if (serviceId && (!selectedService || !loadServicePlans || !planReady))
        throw new Error(
          'Review and save the translation settings for this service before starting.',
        );
      const reference =
        selectedService && loadServicePlans
          ? serviceReference(
              selectedService,
              (await loadServicePlans(selectedService.id)).services.find(
                (item) => item.id === selectedService.id,
              ),
              settings,
            )
          : undefined;
      await api.create(connection, {
        ...(reference ? { serviceReference: reference } : {}),
        translationProfile: profileId,
        transcriptionProvider: recognition,
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
        contextDocumentIds: useNotes ? noteIds : [],
        shareSermonNotesWithEconomy: useNotes && profileId === 'economy' && shareNotes,
        expectedDurationMinutes: 120,
        budgetWarningUsd: 20,
      });
    }
    await api.start(connection);
  }
  const shownSource = locked && session ? session.sourceLanguage : source;
  const baseProfile = locked
    ? session?.translationProfile
    : preflight?.translationProfiles?.find((profile) => profile.id === profileId);
  const recognitionModel = locked
    ? session?.transcription?.model
    : recognition === 'openai'
      ? baseProfile?.transcriptionModel
      : recognition === 'muse'
        ? 'muse-voice-transcribe-1.0'
        : preflight?.transcription?.[shownSource === 'en' ? 'english' : 'russian'].model;
  const selectedProfile =
    baseProfile && recognitionModel
      ? {
          ...baseProfile,
          transcriptionModel: recognitionModel,
          rates: {
            ...baseProfile.rates,
            transcriptionPerMinuteUsd: recognitionRateUsd(recognitionModel),
          },
        }
      : baseProfile;
  const profileReady =
    locked && !session?.translationProfile ? preflight?.openai?.configured : selectedProfile?.ready;
  const notesReady =
    locked || !useNotes || (noteIds.length > 0 && (profileId !== 'economy' || shareNotes));
  const shownNoteIds = locked && session ? session.contextDocumentIds : useNotes ? noteIds : [];
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
          {loadServicePlans && saveServicePlan && (
            <section aria-label="Prepared service">
              <label>
                Prepared service
                <select
                  value={serviceId}
                  disabled={locked || busy || planBusy}
                  onChange={(event) => {
                    if (
                      selectedService &&
                      !sameSettings(settings, selectedService.settings) &&
                      !window.confirm(
                        'Discard unsaved translation settings and choose another service?',
                      )
                    )
                      return;
                    setServiceId(event.target.value);
                    setPlanNotice('');
                    setPlanError('');
                    applyPlan(plans.find((plan) => plan.id === event.target.value));
                  }}
                >
                  <option value="">Unplanned service</option>
                  {serviceId && !selectedService && (
                    <option value={serviceId}>Selected service unavailable</option>
                  )}
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.serviceDate} · {plan.title}
                    </option>
                  ))}
                </select>
              </label>
              {locked && session?.serviceReference && (
                <p className="hint">
                  Running service: {session.serviceReference.title} ·{' '}
                  {session.serviceReference.serviceDate}
                </p>
              )}
              {!locked && selectedService && (
                <p className="hint">
                  {selectedService.stale
                    ? 'The service changed after these choices were saved. Review them and save again.'
                    : planReady
                      ? 'Saved translation settings loaded.'
                      : 'Review the choices below, then save for this service.'}
                </p>
              )}
              {planError && (
                <p className="notice" role="alert">
                  {planError}
                </p>
              )}
              {planNotice && <p role="status">{planNotice}</p>}
              <div className="actions">
                <button
                  disabled={
                    locked || busy || planBusy || !selectedService || (useNotes && !noteIds.length)
                  }
                  onClick={() =>
                    void act(async () => {
                      if (!selectedService) return;
                      const result = await saveServicePlan({
                        serviceId: selectedService.id,
                        serviceRevision: selectedService.serviceRevision,
                        baseRevision: selectedService.revision,
                        settings,
                      });
                      setPlans((previous) =>
                        previous.map((plan) =>
                          plan.id === result.service.id ? result.service : plan,
                        ),
                      );
                      setPlanNotice('Translation settings saved for this service.');
                      setPlanError('');
                    })
                  }
                >
                  Save for this service
                </button>
                <button
                  disabled={locked || busy || planBusy}
                  onClick={() => {
                    if (
                      selectedService &&
                      !sameSettings(settings, selectedService.settings) &&
                      !window.confirm(
                        'Discard unsaved translation settings and reload this service?',
                      )
                    )
                      return;
                    void reloadPlans();
                  }}
                >
                  {planBusy ? 'Loading services…' : 'Reload services'}
                </button>
              </div>
              <p className="hint">
                Saving does not start translation or open an audio input. Economy’s note-sharing
                choice is saved only for this service and these selected notes.
              </p>
            </section>
          )}

          <label>
            Speaker’s language
            <select
              value={shownSource}
              disabled={locked || busy || planBusy}
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
              disabled={locked || busy || planBusy}
              onChange={(event) => {
                setShareNotes(false);
                setProfileId(event.target.value as TranslationProfileId);
              }}
            >
              {locked && !selectedProfile && (
                <option value="legacy">Existing server configuration</option>
              )}
              <option value="quality">Quality</option>
              <option value="economy">Economy · shared-data allowance</option>
            </select>
          </label>
          <label>
            Speech recognition
            <select
              value={locked ? (session?.transcriptionProvider ?? 'auto') : recognition}
              disabled={locked || busy || planBusy}
              onChange={(event) => setRecognition(event.target.value as 'auto' | 'muse' | 'openai')}
            >
              <option value="auto">Automatic · prefer Muse for English</option>
              <option
                value="muse"
                disabled={shownSource !== 'en' || !preflight?.transcription?.muse.configured}
              >
                Muse · English
              </option>
              <option value="openai">OpenAI</option>
            </select>
          </label>
          <p className="hint">
            {locked
              ? session?.transcription?.detail
              : recognition === 'muse'
                ? 'Muse recognizes English. Russian requires Automatic or OpenAI.'
                : recognition === 'openai'
                  ? 'OpenAI recognition selected.'
                  : preflight?.transcription?.[shownSource === 'en' ? 'english' : 'russian'].detail}
          </p>
          {museSettings && (
            <MuseSettings
              access={museSettings}
              onChanged={() => {
                void api.preflight(connection).then((value) => setPreflight(value as Preflight));
              }}
            />
          )}
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
                    Selected sermon notes are included only with your explicit choice below. OpenAI
                    may cover eligible text usage; remaining allowance is unverified. Recognition
                    and voice are additional charges.
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
          {session?.usage && (
            <ServiceUsagePanel usage={session.usage} budgetWarningUsd={session.budgetWarningUsd} />
          )}
          {!locked && useNotes && profileId === 'economy' && !shareNotes && (
            <p className="hint">
              Before starting, open Sermon notes and choose whether to share the selected notes with
              Economy, or turn notes off.
            </p>
          )}
          <details className="sermon-notes">
            <summary>
              Sermon notes · {shownNoteIds.length ? `${shownNoteIds.length} selected` : 'Optional'}
            </summary>
            <p className="hint">
              Relevant excerpts help with names, Scripture wording and terminology. The translator
              must follow the words actually spoken, not read ahead from the notes.
            </p>
            <label className="toggle">
              <input
                type="checkbox"
                checked={locked ? shownNoteIds.length > 0 : useNotes}
                disabled={locked || busy || planBusy}
                onChange={(event) => {
                  setUseNotes(event.target.checked);
                  setShareNotes(false);
                }}
              />
              Use sermon notes for translation
            </label>
            {(useNotes || shownNoteIds.length > 0) && (
              <>
                {notesError && (
                  <p role="alert" className="notice">
                    {notesError}
                  </p>
                )}
                <label>
                  Upload PDF or text notes
                  <input
                    type="file"
                    accept=".pdf,.txt,application/pdf,text/plain"
                    disabled={locked || busy || planBusy || expired}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file)
                        void act(async () => {
                          const document = await api.uploadContextDocument(connection, file);
                          setDocuments((previous) => [
                            ...previous.filter((item) => item.id !== document.id),
                            document,
                          ]);
                          setShareNotes(false);
                          setNoteIds((previous) =>
                            previous.length < 8
                              ? [...new Set([...previous, document.id])]
                              : previous,
                          );
                          setNotesError('');
                        });
                    }}
                  />
                </label>
                <p className="hint">
                  Up to 8 documents, 10 MB each. Uploading keeps them on this church server; only
                  selected excerpts are sent when translation runs.
                </p>
                {documents.map((document) => (
                  <label className="toggle" key={document.id}>
                    <input
                      type="checkbox"
                      checked={shownNoteIds.includes(document.id)}
                      disabled={
                        locked ||
                        busy ||
                        planBusy ||
                        (!noteIds.includes(document.id) && noteIds.length >= 8)
                      }
                      onChange={(event) => {
                        setShareNotes(false);
                        setNoteIds((previous) =>
                          event.target.checked
                            ? [...previous, document.id]
                            : previous.filter((id) => id !== document.id),
                        );
                      }}
                    />
                    {document.filename}
                  </label>
                ))}
                {!locked && !noteIds.length && (
                  <p className="hint">
                    Select or upload notes, or turn notes off to start without them.
                  </p>
                )}
                {selectedProfile?.id === 'economy' && (
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={locked ? session?.shareSermonNotesWithEconomy === true : shareNotes}
                      disabled={locked || busy || planBusy || !noteIds.length}
                      onChange={(event) => setShareNotes(event.target.checked)}
                    />
                    Share selected notes with Economy for this service
                  </label>
                )}
                {selectedProfile?.id === 'economy' && (
                  <p className="hint">
                    Selected excerpts will go to the OpenAI sharing project and may be used to
                    improve its models. Extra context uses input tokens. This choice does not
                    publish the notes to your congregation.
                  </p>
                )}
                {locked && (
                  <p className="hint">
                    Notes are fixed for this service. End or cancel it to change the selection.
                  </p>
                )}
              </>
            )}
          </details>
          <label className="toggle">
            <input
              type="checkbox"
              checked={speechEnabled}
              disabled={
                busy ||
                expired ||
                planBusy ||
                (!speechEnabled && !preflight?.openai?.configured) ||
                (locked && !live)
              }
              onChange={(event) => toggleSpeech(event.target.checked)}
            />
            Generate translated speech
          </label>
          <p>Text continues when speech is off. Turning speech off cancels queued voice output.</p>
          {!preflight?.openai?.configured && (
            <p className="hint">
              Configure the OpenAI audio provider to generate translated speech.
            </p>
          )}
          <div className="actions">
            {!live ? (
              <button
                className="primary"
                disabled={
                  busy ||
                  expired ||
                  !profileReady ||
                  !notesReady ||
                  planBusy ||
                  (!locked && !planReady) ||
                  (locked && session?.state !== 'preflight')
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
          <h2>Audio source</h2>
          {slideAutomation && (
            <p role={automationStatus.phase === 'error' ? 'alert' : 'status'}>
              Slide cues: {automationStatus.phase}. {automationStatus.message || ''}
            </p>
          )}
          <p className="input-status">
            {capture.streaming
              ? live
                ? 'Sending the selected audio feed'
                : 'Input and providers ready · waiting for Start Translate'
              : captureRequested
                ? 'Connecting this input…'
                : snapshot.capture.ready
                  ? 'Another console is sending audio'
                  : snapshot.capture.connected
                    ? 'Another console is connecting'
                    : 'No mixer connected'}
          </p>
          <label>
            Audio from
            <select
              value={deviceId ?? ''}
              disabled={captureRequested}
              onChange={(event) => setDeviceId(event.target.value || undefined)}
            >
              <option value="">System default</option>
              {slideAutomation?.computerAudio && (
                <option value="syncshow:computer-audio">
                  Computer audio · Safari and other apps
                </option>
              )}
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
              : deviceId === 'syncshow:computer-audio'
                ? 'Captures sound from all computer apps. Only audio is sent; close or mute unrelated apps.'
                : 'Opening these controls does not activate an input.'}
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
      {requestArchiveAccess && <ManagedArchives requestAccess={requestArchiveAccess} />}
    </main>
  );
}
