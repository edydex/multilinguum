import { useEffect, useMemo, useRef, useState } from 'react';
import { ServiceUsagePanel } from './ServiceUsagePanel';
import type {
  ArchiveManifest,
  Language,
  PipelineLatencySample,
  TranscriptSegment,
} from '@multilinguum/protocol';
import { api, type OperatorConnection } from './api';
import {
  activeWordIndex,
  audioTimeAtSource,
  buildReviewTrack,
  parseJsonLines,
  sourceTimeAtAudio,
  wordAudioTime,
  type ReviewSegment,
  type ReviewTrack,
} from './archiveReviewModel';

interface ArchiveReviewProps {
  archive: ArchiveManifest;
  connection?: OperatorConnection;
  requestConnection?: () => Promise<OperatorConnection>;
  onClose: () => void;
  onError: (message: string) => void;
}

const languageNames: Record<Language, string> = {
  en: 'English',
  ru: 'Russian',
  es: 'Spanish',
  uk: 'Ukrainian',
};

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function words(segment: ReviewSegment): string[] {
  if (segment.wordTimings?.length) return segment.wordTimings.map((word) => word.text);
  return segment.text.trim().split(/\s+/).filter(Boolean);
}

export function ArchiveReview({
  archive,
  connection,
  requestConnection,
  onClose,
  onError,
}: ArchiveReviewProps) {
  const [tracks, setTracks] = useState<Partial<Record<Language, ReviewTrack>>>({});
  const [language, setLanguage] = useState<Language>('en');
  const [loading, setLoading] = useState(true);
  const [audioMs, setAudioMs] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<{ audioMs: number; play: boolean } | undefined>(undefined);

  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  const currentError = useRef(onError);
  currentError.current = onError;

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setTracks({});
      try {
        const authorized = requestConnection
          ? await requestConnection()
          : currentConnection.current;
        if (!authorized) throw new Error('Connect to the recording server to review this service.');
        if (cancelled) return;
        const latency = archive.latencyReport.sha256
          ? parseJsonLines<PipelineLatencySample>(
              await (
                await api.archiveLatency(authorized, archive.sessionId, controller.signal)
              ).text(),
            )
          : [];
        const loaded = await Promise.all(
          [...new Set(archive.transcripts.map((track) => track.language))].map(
            async (nextLanguage) => {
              const audioTrack = archive.audioTracks.find(
                (track) => track.language === nextLanguage && track.sha256,
              );
              const transcriptTrack = archive.transcripts.find(
                (track) => track.language === nextLanguage && track.sha256,
              );
              if (!transcriptTrack) return undefined;
              const [audio, transcriptBlob] = await Promise.all([
                audioTrack
                  ? api.archiveAudio(
                      authorized,
                      archive.sessionId,
                      audioTrack.channelId,
                      controller.signal,
                    )
                  : undefined,
                api.archiveTranscript(
                  authorized,
                  archive.sessionId,
                  transcriptTrack.channelId,
                  controller.signal,
                ),
              ]);
              const transcript = parseJsonLines<TranscriptSegment>(await transcriptBlob.text());
              if (cancelled || controller.signal.aborted) return undefined;
              const audioUrl = audio ? URL.createObjectURL(audio) : undefined;
              if (audioUrl) urls.push(audioUrl);
              return buildReviewTrack(
                nextLanguage,
                transcriptTrack.channelId,
                audioUrl,
                transcript,
                latency,
                archive.sourceLanguage,
              );
            },
          ),
        );
        if (cancelled) return;
        const nextTracks = Object.fromEntries(
          loaded
            .filter((track): track is ReviewTrack => Boolean(track))
            .map((track) => [track.language, track]),
        ) as Partial<Record<Language, ReviewTrack>>;
        setTracks(nextTracks);
        setLanguage(
          nextTracks[archive.sourceLanguage]
            ? archive.sourceLanguage
            : (loaded.find((track) => track)?.language ?? archive.sourceLanguage),
        );
        setAudioMs(0);
      } catch (cause) {
        controller.abort();
        for (const url of urls) URL.revokeObjectURL(url);
        if (!cancelled)
          currentError.current(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [archive, connection?.baseUrl, requestConnection]);

  const activeTrack = tracks[language];
  const activeSegment = useMemo(() => {
    if (!activeTrack?.audioUrl) return undefined;
    return (
      activeTrack.segments.find(
        (segment) => audioMs >= segment.audioStartMs && audioMs < segment.audioEndMs,
      ) ?? [...activeTrack.segments].reverse().find((segment) => audioMs >= segment.audioStartMs)
    );
  }, [activeTrack, audioMs]);
  const sourceMs = activeTrack ? sourceTimeAtAudio(activeTrack, audioMs) : 0;

  const applyPendingSeek = () => {
    const audio = audioRef.current;
    const pending = pendingSeek.current;
    if (!audio || !pending) return;
    audio.currentTime = pending.audioMs / 1_000;
    setAudioMs(pending.audioMs);
    pendingSeek.current = undefined;
    if (pending.play) void audio.play().catch(() => undefined);
  };

  const switchLanguage = (nextLanguage: Language) => {
    const currentTrack = activeTrack;
    const nextTrack = tracks[nextLanguage];
    const audio = audioRef.current;
    if (!currentTrack || !nextTrack || nextLanguage === language) return;
    const semanticPosition = sourceTimeAtAudio(
      currentTrack,
      audio ? audio.currentTime * 1_000 : audioMs,
    );
    const nextAudioMs = audioTimeAtSource(nextTrack, semanticPosition);
    pendingSeek.current = nextTrack.audioUrl
      ? {
          audioMs: nextAudioMs,
          play: Boolean(audio && !audio.paused),
        }
      : undefined;
    audio?.pause();
    setAudioMs(nextAudioMs);
    setLanguage(nextLanguage);
  };

  const seek = (segment: ReviewSegment, wordIndex = 0, wordCount = 1) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextAudioMs = wordAudioTime(segment, wordIndex, wordCount);
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      pendingSeek.current = { audioMs: nextAudioMs, play: true };
      setAudioMs(nextAudioMs);
      return;
    }
    audio.currentTime = nextAudioMs / 1_000;
    setAudioMs(nextAudioMs);
    void audio.play().catch(() => undefined);
  };

  if (loading) {
    return (
      <section className="panel review-page">
        <button className="review-back" onClick={onClose}>
          ← Recorded services
        </button>
        <div className="empty" role="status">
          Preparing recorded service…
        </div>
      </section>
    );
  }

  if (!activeTrack) {
    return (
      <section className="panel review-page">
        <button className="review-back" onClick={onClose}>
          ← Recorded services
        </button>
        <div className="empty">
          This recording does not contain a finalized transcript to review.
        </div>
        {archive.usage && <ServiceUsagePanel usage={archive.usage} />}
      </section>
    );
  }

  return (
    <section className="panel review-page">
      <div className="review-heading">
        <div>
          <button className="review-back" onClick={onClose}>
            ← Recorded services
          </button>
          <p className="eyebrow">RECORDED SERVICE REVIEW</p>
          <h2>{archive.serviceReference?.title || new Date(archive.createdAt).toLocaleString()}</h2>
          <p>
            {activeTrack.audioUrl
              ? 'Click a word to hear that moment. Language switching keeps the same sermon thought.'
              : 'Read the finalized transcript below. No audio was recorded for this language.'}
          </p>
        </div>
        <div className="review-position">
          <span>Source position</span>
          <strong>{formatTime(sourceMs)}</strong>
          <small>
            of{' '}
            {formatTime(Math.max(0, ...activeTrack.segments.map((segment) => segment.sourceEndMs)))}
          </small>
        </div>
      </div>

      {archive.usage && <ServiceUsagePanel usage={archive.usage} />}
      <div className="review-controls">
        <div className="review-language" role="group" aria-label="Review language">
          {(Object.keys(tracks) as Language[]).map((value) => (
            <button
              key={value}
              className={language === value ? 'active' : ''}
              onClick={() => switchLanguage(value)}
            >
              <span>{value.toUpperCase()}</span> {languageNames[value]}{' '}
              {value === archive.sourceLanguage ? 'original' : 'translation'}
            </button>
          ))}
        </div>
        {activeTrack.audioUrl && (
          <audio
            key={activeTrack.audioUrl}
            ref={audioRef}
            controls
            src={activeTrack.audioUrl}
            onLoadedMetadata={applyPendingSeek}
            onTimeUpdate={(event) => setAudioMs(event.currentTarget.currentTime * 1_000)}
            onSeeked={(event) => setAudioMs(event.currentTarget.currentTime * 1_000)}
          />
        )}
        <div className="review-clock">
          <strong>{formatTime(audioMs)}</strong>
          <span>/ {formatTime(activeTrack.durationMs)}</span>
        </div>
      </div>

      {activeTrack.audioUrl && (
        <div className="review-key">
          <span>
            <i className="current" /> currently spoken
          </span>
          <span>
            <i /> click a word to seek
          </span>
          <span>Word timing is estimated within each finalized phrase.</span>
        </div>
      )}

      <div className="review-transcript" aria-label={`${language.toUpperCase()} transcript`}>
        {activeTrack.segments.map((segment) => {
          const tokens = words(segment);
          const isActive = activeSegment?.sequence === segment.sequence;
          const currentWord = isActive ? activeWordIndex(segment, audioMs, tokens.length) : -1;
          return (
            <article
              className={`review-line ${isActive ? 'active' : ''}`}
              key={`${segment.channelId}-${segment.sequence}`}
            >
              {activeTrack.audioUrl ? (
                <button className="review-time" onClick={() => seek(segment)}>
                  {formatTime(segment.audioStartMs)}
                </button>
              ) : (
                <span className="review-time">{formatTime(segment.sourceStartMs)}</span>
              )}
              <p>
                {activeTrack.audioUrl
                  ? tokens.map((token, index) => (
                      <button
                        className={`review-word ${currentWord === index ? 'current' : ''}`}
                        key={`${segment.sequence}-${index}`}
                        onClick={() => seek(segment, index, tokens.length)}
                      >
                        {token}
                      </button>
                    ))
                  : segment.text}
              </p>
              <span className="review-source-time">source {formatTime(segment.sourceStartMs)}</span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
